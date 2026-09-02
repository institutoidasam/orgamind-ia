import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type { ConfigService } from '@nestjs/config';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConsentAction, ConsentSource } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ConsentService } from './consent.service';
import { PublicConsentService } from './public-consent.service';
import { OrganizationService } from '../organization/organization.service';
import type { Env } from '../../shared/config/env.schema';

/** A organização titular DESTE deploy — configuração, não constante de código. */
const ORG = {
  id: 'singleton',
  name: 'CONTINUUM',
  legalName: 'Canal do Matheus Garcia - CONTINUUM',
  privacyPolicyUrl: null,
  supportContact: null,
};

const BODY_V1 =
  'Autorizo CONTINUUM (Canal do Matheus Garcia - CONTINUUM) a me enviar mensagens no WhatsApp sobre convites para cursos, oficinas e eventos.\n' +
  'São no máximo 2 mensagens por mês. Posso sair quando quiser respondendo PARAR.\n' +
  'Minha resposta não afeta em nada meu acesso aos projetos e serviços de CONTINUUM.\n' +
  'Política de privacidade: {url}';

const META = {
  ip: '200.1.2.3',
  userAgent: 'Mozilla/5.0 (Android)',
  url: 'https://picoa.exemplo.org/opt-in?purposeKey=convite_atividades',
};

function makeService(org: typeof ORG = ORG) {
  const prisma = mockDeep<PrismaService>();
  const consent = mockDeep<ConsentService>();
  const organization = mockDeep<OrganizationService>();
  organization.get.mockResolvedValue(org);
  const config = {
    get: vi.fn((key: string) =>
      key === 'APP_BASE_URL' ? 'https://picoa.exemplo.org' : undefined,
    ),
  } as unknown as ConfigService<Env>;

  // Caminho feliz por padrão: finalidade ativa, texto publicado, ninguém suprimido.
  consent.findActivePurpose.mockResolvedValue({
    key: 'convite_atividades',
    label: 'Convites para cursos, oficinas e eventos',
    description: 'Inscrições, chamadas e mutirões.',
    isSensitive: false,
  });
  consent.isSuppressed.mockResolvedValue(false);
  consent.record.mockResolvedValue({ eventId: 'ev1', created: true });
  prisma.consentText.findFirst.mockResolvedValue({
    version: 'optin-v1',
    body: BODY_V1,
  } as never);
  // C5 — a busca do titular é por VARIANTE do 9º dígito (findMany), não por
  // igualdade exata (findUnique). O findUnique sobrou só no catch da corrida P2002.
  prisma.contact.findMany.mockResolvedValue([] as never);
  prisma.contact.findUnique.mockResolvedValue(null);
  prisma.contact.create.mockResolvedValue({ id: 'contact-novo' } as never);

  const service = new PublicConsentService(
    prisma,
    consent,
    config,
    organization,
  );
  return { service, prisma, consent, organization };
}

const VALID = {
  phone: '(92) 98765-4321',
  name: 'Maria da Silva',
  purposeKey: 'convite_atividades',
  accepted: true,
};

describe('PublicConsentService.activeText — GET /public/consent-text', () => {
  let service: PublicConsentService;
  let prisma: MockProxy<PrismaService>;
  let consent: MockProxy<ConsentService>;

  beforeEach(() => {
    ({ service, prisma, consent } = makeService());
  });

  it('devolve o texto canônico VIGENTE com {url} resolvido e a versão', async () => {
    const view = await service.activeText('convite_atividades');

    expect(view.version).toBe('optin-v1');
    expect(view.purposeLabel).toBe('Convites para cursos, oficinas e eventos');
    // Nomeia a organização, a finalidade e como sair — os 3 requisitos da Meta + LGPD.
    expect(view.body).toContain('CONTINUUM');
    expect(view.body).toContain('convites para cursos, oficinas e eventos');
    expect(view.body).toContain('PARAR');
    // O placeholder do texto versionado NÃO pode vazar para a tela.
    expect(view.body).not.toContain('{url}');
    expect(view.body).toContain('https://picoa.exemplo.org/privacidade');
  });

  it('`{url}` resolve para a política de privacidade CONFIGURADA quando ela existe', async () => {
    ({ service } = makeService({
      ...ORG,
      privacyPolicyUrl: 'https://continuum.exemplo.br/privacidade',
    }));

    const view = await service.activeText('convite_atividades');

    expect(view.body).toContain('https://continuum.exemplo.br/privacidade');
    expect(view.body).not.toContain('picoa.exemplo.org/privacidade');
  });

  it('recusa finalidade inexistente/inativa (nunca renderiza texto para key desconhecida)', async () => {
    consent.findActivePurpose.mockResolvedValue(null);
    await expect(
      service.activeText('finalidade_que_nao_existe'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('recusa finalidade sem ConsentText publicado — não se inventa o texto da prova', async () => {
    prisma.consentText.findFirst.mockResolvedValue(null);
    await expect(
      service.activeText('convite_atividades'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PublicConsentService.submit — POST /public/opt-in', () => {
  let service: PublicConsentService;
  let prisma: MockProxy<PrismaService>;
  let consent: MockProxy<ConsentService>;

  beforeEach(() => {
    ({ service, prisma, consent } = makeService());
  });

  it('grava GRANT com a evidência COMPLETA da spec §3.2 e cria o contato', async () => {
    const result = await service.submit(VALID, META);

    expect(result.status).toBe('ok');
    expect(prisma.contact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phoneE164: '+5592987654321',
          name: 'Maria da Silva',
        }),
      }),
    );

    expect(consent.record).toHaveBeenCalledOnce();
    const arg = consent.record.mock.calls[0][0];
    expect(arg).toMatchObject({
      contactId: 'contact-novo',
      phoneE164: '+5592987654321',
      purposeKey: 'convite_atividades',
      action: ConsentAction.GRANT,
      source: ConsentSource.WEB_FORM,
      consentTextVersion: 'optin-v1',
    });
    // A prova é o TEXTO exibido, resolvido no servidor — nunca o que o cliente mandou.
    expect(arg.evidenceText).toContain('CONTINUUM');
    expect(arg.evidenceText).toContain('https://picoa.exemplo.org/privacidade');
    const evidence = arg.evidence as Record<string, unknown>;
    expect(evidence).toMatchObject({
      ip: META.ip,
      userAgent: META.userAgent,
      url: META.url,
      checkboxes: ['convite_atividades'],
    });
    expect(evidence.submissionId).toEqual(expect.any(String));
  });

  it('HONEYPOT preenchido → 200 genérico e NADA gravado (indistinguível do sucesso)', async () => {
    const result = await service.submit(
      { ...VALID, website: 'http://spam.example' },
      META,
    );

    expect(result.status).toBe('ok');
    // Mesma mensagem do sucesso: se a resposta denunciasse o honeypot, o bot
    // aprenderia a deixá-lo vazio.
    expect(result.message).toBe((await service.submit(VALID, META)).message);
    expect(consent.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ website: expect.anything() }),
    );
    expect(consent.record).toHaveBeenCalledTimes(1); // só a 2ª submissão, a legítima
  });

  it('submissão em menos de 2s desde o render → descartada em silêncio (bot)', async () => {
    const result = await service.submit(
      { ...VALID, renderedAt: new Date() },
      META,
    );

    expect(result.status).toBe('ok');
    expect(consent.record).not.toHaveBeenCalled();
  });

  it('telefone inválido → 400 em PT-BR, nenhum contato criado', async () => {
    await expect(
      service.submit({ ...VALID, phone: '99999' }, META),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(consent.record).not.toHaveBeenCalled();
  });

  it('checkbox não marcado → 400: sem ato afirmativo não há consentimento', async () => {
    await expect(
      service.submit({ ...VALID, accepted: false }, META),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(consent.record).not.toHaveBeenCalled();
  });

  it('a mensagem do checkbox não marcado nomeia a organização CONFIGURADA', async () => {
    await expect(
      service.submit({ ...VALID, accepted: false }, META),
    ).rejects.toThrow(/CONTINUUM/);
  });

  it('purposeKey inexistente → 404 e nada gravado', async () => {
    consent.findActivePurpose.mockResolvedValue(null);
    await expect(
      service.submit({ ...VALID, purposeKey: 'nao_existe' }, META),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(consent.record).not.toHaveBeenCalled();
  });

  it('telefone SUPRIMIDO → recusa amigável e NÃO ressuscita quem pediu PARAR', async () => {
    consent.isSuppressed.mockResolvedValue(true);

    const result = await service.submit(VALID, META);

    expect(result.status).toBe('suppressed');
    expect(result.message).toMatch(/PARAR|VOLTAR/);
    // Nomeia a organização configurada, não uma constante de código.
    expect(result.message).toContain('CONTINUUM');
    expect(result.message).not.toMatch(/idasam/i);
    // O ponto inteiro: record(GRANT) levantaria a supressão (regra 4 do §2.7), e
    // um formulário público não prova posse do número — qualquer um digitaria o
    // telefone de um terceiro para reinscrevê-lo.
    expect(consent.record).not.toHaveBeenCalled();
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  /**
   * C5.3 — a landing também cria contato, e o contato criado pode ser uma pessoa
   * que já consentiu (para OUTRA finalidade) antes de a linha ser apagada. Sem a
   * reidratação, a submissão de hoje concede a finalidade de hoje e as outras
   * ficam para trás — silenciosamente perdidas, apesar de estarem na trilha.
   */
  it('contato NOVO reidrata o consentimento da trilha do phoneHash, antes do GRANT', async () => {
    await service.submit(VALID, META);

    expect(consent.rehydrate).toHaveBeenCalledWith('contact-novo', '+5592987654321');
    expect(consent.rehydrate.mock.invocationCallOrder[0]).toBeLessThan(
      consent.record.mock.invocationCallOrder[0],
    );
  });

  it('contato que JÁ EXISTIA não é reidratado — o estado derivado dele está vivo', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c-existente', name: 'Maria', phoneE164: '+5592987654321' },
    ] as never);

    await service.submit(VALID, META);

    expect(consent.rehydrate).not.toHaveBeenCalled();
    expect(consent.record).toHaveBeenCalledOnce();
  });

  it('telefone já cadastrado → MESMA resposta genérica (não vaza existência de contato)', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c-existente', name: 'Maria', phoneE164: '+5592987654321' },
    ] as never);

    const existing = await service.submit(VALID, META);
    prisma.contact.findMany.mockResolvedValue([] as never);
    const fresh = await service.submit(VALID, META);

    expect(existing).toEqual(fresh);
    expect(consent.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ contactId: 'contact-novo' }),
    );
  });

  it('contato já existente com nome NÃO é sobrescrito pelo formulário público', async () => {
    prisma.contact.findMany.mockResolvedValue([
      {
        id: 'c-existente',
        name: 'Nome do cadastro do IDASAM',
        phoneE164: '+5592987654321',
      },
    ] as never);

    await service.submit({ ...VALID, name: 'Nome Falso' }, META);

    expect(prisma.contact.update).not.toHaveBeenCalled();
    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'c-existente' }),
    );
  });

  /**
   * C5 — a landing pública é o terceiro escritor de contato, e casava o titular
   * por igualdade EXATA de string. Quem já estava na base como `+5592995550101`
   * e digitou o número na forma de 12 dígitos ganhava um SEGUNDO Contact — que
   * a reidratação (C7) faz nascer GRANTED e passar o gate de campanha.
   */
  it('acha o titular pela OUTRA grafia do 9º dígito — não cria o gêmeo', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c-existente', phoneE164: '+5592995550101', name: 'Maria' },
    ] as never);

    await service.submit({ ...VALID, phone: '(92) 9555-0101' }, META);

    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'c-existente' }),
    );
  });

  it('a busca do titular consulta as DUAS grafias (o where, não o retorno)', async () => {
    prisma.contact.findMany.mockResolvedValue([] as never);

    await service.submit({ ...VALID, phone: '(92) 9555-0101' }, META);

    expect(prisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          phoneE164: { in: ['+559295550101', '+5592995550101'] },
        },
      }),
    );
  });

  it('contato existente SEM nome recebe o nome que o próprio titular declarou', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c-existente', name: null, phoneE164: '+5592987654321' },
    ] as never);
    prisma.contact.update.mockResolvedValue({ id: 'c-existente' } as never);

    await service.submit(VALID, META);

    expect(prisma.contact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'c-existente' },
        data: { name: 'Maria da Silva' },
      }),
    );
  });
});
