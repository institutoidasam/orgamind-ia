import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ConfigService } from '@nestjs/config';
import {
  ZernioTemplateService,
  mapZernioTemplateStatus,
} from './zernio-template.service';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BASE = 'https://zernio.test/api/v1';
const TEMPLATES_URL = `${BASE}/whatsapp/templates`;

function makeConfig(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    ZERNIO_API_KEY: 'zk_test_key',
    ZERNIO_BASE_URL: BASE,
    ...overrides,
  };
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

/**
 * O status BRUTO da Meta → o enum do orgamind. O gate de campanha só aceita
 * APPROVED, então a regra de ouro é: **um status que não conheço NUNCA pode
 * abrir o gate**.
 */
describe('mapZernioTemplateStatus', () => {
  it.each([
    ['APPROVED', 'APPROVED'],
    ['REJECTED', 'REJECTED'],
    ['PENDING', 'PENDING'],
    // A listagem só devolve APPROVED/PENDING/REJECTED; o WEBHOOK amplia para
    // estes. Antes, um DISABLED explodia no Zod e derrubava o sync inteiro.
    ['PAUSED', 'PAUSED'],
    ['DISABLED', 'PAUSED'],
    ['PENDING_DELETION', 'PAUSED'],
    ['IN_APPEAL', 'PENDING'],
  ])('mapeia %s → %s', (raw, expected) => {
    expect(mapZernioTemplateStatus(raw)).toBe(expected);
  });

  it('tolera caixa e espaços', () => {
    expect(mapZernioTemplateStatus(' approved ')).toBe('APPROVED');
  });

  // O ponto: a Meta pode inventar um status amanhã. Ele não pode derrubar o
  // sync (Zod), e não pode virar APPROVED por acidente.
  it.each([undefined, null, '', 'STATUS_QUE_A_META_INVENTOU_AMANHA'])(
    'status desconhecido (%s) → PENDING, sem lançar',
    (raw) => {
      expect(mapZernioTemplateStatus(raw)).toBe('PENDING');
    },
  );
});

describe('ZernioTemplateService', () => {
  describe('list', () => {
    it('lista os templates de UMA conta (accountId é obrigatório na query)', async () => {
      server.use(
        http.get(TEMPLATES_URL, ({ request }) => {
          expect(new URL(request.url).searchParams.get('accountId')).toBe(
            'acc_1',
          );
          return HttpResponse.json({
            success: true,
            templates: [
              {
                id: '833669913010819',
                name: 'bem_vindo_mg',
                status: 'APPROVED',
                category: 'MARKETING',
                language: 'pt_BR',
                components: [{ type: 'BODY', text: 'Oi, aqui é o Matheus.' }],
                quality_score: { score: 'UNKNOWN', date: 1783790714 },
              },
            ],
          });
        }),
      );

      const items = await new ZernioTemplateService(makeConfig()).list('acc_1');

      expect(items).toEqual([
        {
          id: '833669913010819',
          name: 'bem_vindo_mg',
          status: 'APPROVED',
          category: 'MARKETING',
          language: 'pt_BR',
          components: [{ type: 'BODY', text: 'Oi, aqui é o Matheus.' }],
          qualityScore: 'UNKNOWN',
        },
      ]);
    });

    // Um item torto não pode levar o catálogo inteiro junto: o resto dos
    // templates daquela WABA precisa entrar.
    it('pula item sem nome, mantendo os demais', async () => {
      server.use(
        http.get(TEMPLATES_URL, () =>
          HttpResponse.json({
            success: true,
            templates: [
              { id: '1', status: 'APPROVED', language: 'pt_BR' }, // sem `name`
              {
                id: '2',
                name: 'boas_vindas',
                status: 'APPROVED',
                category: 'MARKETING',
                language: 'pt_BR',
              },
            ],
          }),
        ),
      );

      const items = await new ZernioTemplateService(makeConfig()).list('acc_1');

      expect(items).toHaveLength(1);
      expect(items[0].name).toBe('boas_vindas');
    });

    // O status desconhecido é preservado CRU aqui — quem mapeia (com perda) é o
    // sync. Perder o raw seria perder o diagnóstico.
    it('preserva o status cru, mesmo desconhecido', async () => {
      server.use(
        http.get(TEMPLATES_URL, () =>
          HttpResponse.json({
            success: true,
            templates: [
              {
                id: '1',
                name: 't',
                status: 'PENDING_DELETION',
                language: 'pt_BR',
              },
            ],
          }),
        ),
      );

      const items = await new ZernioTemplateService(makeConfig()).list('acc_1');

      expect(items[0].status).toBe('PENDING_DELETION');
    });

    it('resposta sem templates → lista vazia', async () => {
      server.use(
        http.get(TEMPLATES_URL, () => HttpResponse.json({ success: true })),
      );

      await expect(
        new ZernioTemplateService(makeConfig()).list('acc_1'),
      ).resolves.toEqual([]);
    });

    // Diferente da saúde (ZB), aqui LANÇAR é o certo: quem chama precisa saber
    // que o catálogo daquela conta não veio, para não concluir "0 templates" e
    // marcar os locais como removidos.
    it('erro da API → lança (o sync precisa distinguir "vazio" de "não veio")', async () => {
      server.use(
        http.get(TEMPLATES_URL, () => new HttpResponse(null, { status: 500 })),
      );

      await expect(
        new ZernioTemplateService(makeConfig()).list('acc_1'),
      ).rejects.toThrow();
    });
  });

  it('sem ZERNIO_API_KEY → configured=false', () => {
    expect(
      new ZernioTemplateService(makeConfig({ ZERNIO_API_KEY: undefined }))
        .configured,
    ).toBe(false);
  });
});
