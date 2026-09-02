import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ConfigService } from '@nestjs/config';
import {
  ZernioAccountsService,
  zernioPhoneToE164,
  parseZernioTier,
} from './zernio-accounts.service';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const API_KEY = 'zk_test_key';
const BASE = 'https://zernio.test/api/v1';
const ACCOUNTS_URL = `${BASE}/accounts`;
const NUMBER_INFO_URL = `${BASE}/whatsapp/number-info`;

function makeConfig(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    ZERNIO_API_KEY: API_KEY,
    ZERNIO_BASE_URL: BASE,
    ...overrides,
  };
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

/** Uma conta como `GET /accounts` devolve. */
function rawAccount(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'a1b2c3d4e5f6a7b8c9d0e1f2',
    displayName: 'Canal do Matheus - CONTINUUM',
    metadata: {
      displayPhoneNumber: '+55 92 99999-8888',
      wabaId: '1234567890',
      qualityRating: 'GREEN',
      messagingLimitTier: 'TIER_1K',
      nameStatus: 'DECLINED',
    },
    ...overrides,
  };
}

/**
 * O payload REAL de `GET /whatsapp/number-info?accountId=` (capturado ao vivo
 * na conta do cliente em 12/07). `phone.health_status.entities[]` traz UMA
 * entrada por entidade da Meta (PHONE_NUMBER, WABA, BUSINESS, APP) — só a de
 * PHONE_NUMBER carrega o motivo do capamento.
 */
function rawNumberInfo(
  phoneOverrides: Record<string, unknown> = {},
  topOverrides: Record<string, unknown> = {},
) {
  return {
    phone: {
      verified_name: 'Matheus Garcia',
      display_phone_number: '+55 92 3155-0101',
      quality_rating: 'GREEN',
      whatsapp_business_manager_messaging_limit: 'TIER_2K',
      name_status: 'DECLINED',
      status: 'CONNECTED',
      health_status: {
        can_send_message: 'LIMITED',
        entities: [
          {
            entity_type: 'PHONE_NUMBER',
            id: '1188954390971208',
            can_send_message: 'LIMITED',
            additional_info: [
              'Your display name has not been approved yet. Your message limit will increase after the display name is approved.',
            ],
          },
          { entity_type: 'WABA', id: '1015066594463529', can_send_message: 'AVAILABLE' },
        ],
      },
      ...phoneOverrides,
    },
    nameRejectionReason: 'BIZ_COMMERCE_VIOLATION_OTHER',
    ...topOverrides,
  };
}

// O número vem formatado pela Meta ("+55 92 99999-8888"); Channel.phoneE164
// guarda E.164 puro. Normalizar aqui evita um canal cujo número nunca casa com
// o `To` de um webhook nem com o inbox.
describe('zernioPhoneToE164', () => {
  it.each([
    ['+55 92 99999-8888', '+5592999998888'],
    ['5592999998888', '+5592999998888'],
    ['+5592999998888', '+5592999998888'],
    ['(92) 99999-8888', '+92999998888'],
  ])('normaliza %s → %s', (raw, expected) => {
    expect(zernioPhoneToE164(raw)).toBe(expected);
  });

  it.each([undefined, '', '   ', 'sem-digitos'])(
    'devolve null para %s',
    (raw) => {
      expect(zernioPhoneToE164(raw)).toBeNull();
    },
  );
});

// ZA2 — `metadata.messagingLimitTier` é a escada de usuários ÚNICOS/24h da Meta.
// O canal guarda o teto como número (dailySendLimit), então o tier-sync precisa
// da tradução. Tier DESCONHECIDO/ausente → null: o job NÃO mexe no canal (nunca
// inventar um teto — chutar para cima queima o número, chutar para baixo trava a
// campanha).
describe('parseZernioTier', () => {
  it.each([
    ['TIER_50', 50],
    ['TIER_250', 250],
    ['TIER_1K', 1000],
    ['TIER_2K', 2000],
    ['TIER_10K', 10000],
    ['TIER_100K', 100000],
    ['TIER_UNLIMITED', 1000000],
  ])('mapeia %s → %i', (raw, expected) => {
    expect(parseZernioTier(raw)).toBe(expected);
  });

  it('tolera espaços e caixa baixa (a Meta já mudou de caixa antes)', () => {
    expect(parseZernioTier(' tier_2k ')).toBe(2000);
  });

  it.each([undefined, '', 'TIER_5K', 'UNKNOWN', 'TIER_2000'])(
    'devolve null para %s (desconhecido → não mexe no canal)',
    (raw) => {
      expect(parseZernioTier(raw)).toBeNull();
    },
  );
});

describe('ZernioAccountsService', () => {
  describe('listAccounts', () => {
    it('lista as contas com id, nome, número normalizado e metadados de saúde', async () => {
      server.use(
        http.get(ACCOUNTS_URL, ({ request }) => {
          expect(request.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
          return HttpResponse.json({
            accounts: [rawAccount()],
            hasAnalyticsAccess: true,
          });
        }),
      );

      const svc = new ZernioAccountsService(makeConfig());
      const accounts = await svc.listAccounts();

      expect(accounts).toEqual([
        {
          id: 'a1b2c3d4e5f6a7b8c9d0e1f2',
          displayName: 'Canal do Matheus - CONTINUUM',
          phoneE164: '+5592999998888',
          wabaId: '1234567890',
          qualityRating: 'GREEN',
          messagingLimitTier: 'TIER_1K',
          nameStatus: 'DECLINED',
        },
      ]);
    });

    it('pula contas sem `_id` (shape ruim nunca derruba a listagem inteira)', async () => {
      server.use(
        http.get(ACCOUNTS_URL, () =>
          HttpResponse.json({
            accounts: [
              { displayName: 'sem id' },
              rawAccount({ _id: 'acc_ok', metadata: {} }),
            ],
          }),
        ),
      );

      const accounts = await new ZernioAccountsService(makeConfig()).listAccounts();

      expect(accounts).toEqual([
        {
          id: 'acc_ok',
          displayName: 'Canal do Matheus - CONTINUUM',
          phoneE164: null,
          wabaId: undefined,
          qualityRating: undefined,
          messagingLimitTier: undefined,
          nameStatus: undefined,
        },
      ]);
    });

    it('propaga o erro quando a API do Zernio falha', async () => {
      server.use(
        http.get(ACCOUNTS_URL, () => HttpResponse.json({}, { status: 500 })),
      );

      await expect(
        new ZernioAccountsService(makeConfig()).listAccounts(),
      ).rejects.toThrow();
    });
  });

  describe('lookup', () => {
    it('accountId existente → { status: "found" } com a conta', async () => {
      server.use(
        http.get(ACCOUNTS_URL, () =>
          HttpResponse.json({ accounts: [rawAccount()] }),
        ),
      );

      const res = await new ZernioAccountsService(makeConfig()).lookup(
        'a1b2c3d4e5f6a7b8c9d0e1f2',
      );

      expect(res).toMatchObject({
        status: 'found',
        account: { id: 'a1b2c3d4e5f6a7b8c9d0e1f2', phoneE164: '+5592999998888' },
      });
    });

    it('accountId inexistente → { status: "not_found" } com as contas disponíveis', async () => {
      server.use(
        http.get(ACCOUNTS_URL, () =>
          HttpResponse.json({ accounts: [rawAccount()] }),
        ),
      );

      const res = await new ZernioAccountsService(makeConfig()).lookup('acc_errado');

      expect(res.status).toBe('not_found');
      expect(res.status === 'not_found' && res.accounts).toHaveLength(1);
    });

    it('Zernio fora do ar → { status: "unavailable" } (NUNCA lança — o create degrada)', async () => {
      server.use(http.get(ACCOUNTS_URL, () => HttpResponse.error()));

      const res = await new ZernioAccountsService(makeConfig()).lookup('acc_x');

      expect(res.status).toBe('unavailable');
    });

    it('sem ZERNIO_API_KEY → { status: "unavailable" }, sem chamar a API', async () => {
      // Sem handler registrado: qualquer request de rede faria o msw
      // (onUnhandledRequest: 'error') derrubar o teste.
      const res = await new ZernioAccountsService(
        makeConfig({ ZERNIO_API_KEY: undefined }),
      ).lookup('acc_x');

      expect(res.status).toBe('unavailable');
    });
  });

  // ZC — o `profileId` é campo OBRIGATÓRIO do `POST /broadcasts`. No
  // `GET /accounts` ele vem POPULADO, como objeto `{_id, name}` (verificado ao
  // vivo) — gravar o objeto inteiro no canal viraria "[object Object]" e só
  // apareceria como erro lá na frente, na hora de disparar.
  describe('profileId', () => {
    it('extrai o _id do profileId populado (objeto)', async () => {
      server.use(
        http.get(ACCOUNTS_URL, () =>
          HttpResponse.json({
            accounts: [
              rawAccount({
                profileId: { _id: 'a1b2c3d4e5f6a7b8c9d00001', name: 'Default' },
              }),
            ],
          }),
        ),
      );

      const [account] = await new ZernioAccountsService(
        makeConfig(),
      ).listAccounts();

      expect(account.profileId).toBe('a1b2c3d4e5f6a7b8c9d00001');
    });

    it('aceita o profileId como string crua (a API pode deixar de popular)', async () => {
      server.use(
        http.get(ACCOUNTS_URL, () =>
          HttpResponse.json({
            accounts: [rawAccount({ profileId: 'a1b2c3d4e5f6a7b8c9d00001' })],
          }),
        ),
      );

      const [account] = await new ZernioAccountsService(
        makeConfig(),
      ).listAccounts();

      expect(account.profileId).toBe('a1b2c3d4e5f6a7b8c9d00001');
    });

    it('profileId ausente → undefined (não quebra o parse da conta)', async () => {
      server.use(
        http.get(ACCOUNTS_URL, () =>
          HttpResponse.json({ accounts: [rawAccount({ profileId: null })] }),
        ),
      );

      const [account] = await new ZernioAccountsService(
        makeConfig(),
      ).listAccounts();

      expect(account.profileId).toBeUndefined();
      expect(account.id).toBe('a1b2c3d4e5f6a7b8c9d0e1f2');
    });
  });

  // ZB — `GET /whatsapp/number-info?accountId=` EXISTE (sondado ao vivo em
  // 12/07, HTTP 200). É a leitura mais rica da saúde: além do que `GET /accounts`
  // já dá em `metadata`, traz `health_status.can_send_message` (AVAILABLE |
  // LIMITED | BLOCKED) e o `additional_info` da Meta explicando o PORQUÊ — é ele
  // que revela que o número do cliente está CAPADO (LIMITED), não bloqueado,
  // porque o display name está DECLINED.
  describe('fetchNumberInfo', () => {
    it('normaliza tier, qualidade, nome, número e can_send_message + motivo', async () => {
      server.use(
        http.get(NUMBER_INFO_URL, ({ request }) => {
          // accountId é OBRIGATÓRIO na query — sem ele a API devolve 400.
          expect(new URL(request.url).searchParams.get('accountId')).toBe(
            'acc_1',
          );
          return HttpResponse.json(rawNumberInfo());
        }),
      );

      const health = await new ZernioAccountsService(
        makeConfig(),
      ).fetchNumberInfo('acc_1');

      expect(health).toEqual({
        accountId: 'acc_1',
        displayPhoneNumber: '+55 92 3155-0101',
        messagingLimitTier: 'TIER_2K',
        qualityRating: 'GREEN',
        nameStatus: 'DECLINED',
        nameRejectionReason: 'BIZ_COMMERCE_VIOLATION_OTHER',
        canSendMessage: 'LIMITED',
        canSendMessageReason:
          'Your display name has not been approved yet. Your message limit will increase after the display name is approved.',
      });
    });

    // O motivo do capamento vive na entidade PHONE_NUMBER do health_status —
    // as entidades WABA/BUSINESS/APP estão AVAILABLE e não explicam nada. Pegar
    // o `additional_info` da primeira entidade que aparecer mostraria o texto
    // errado (ou nenhum).
    it('tira o motivo da entidade PHONE_NUMBER, não da primeira entidade da lista', async () => {
      server.use(
        http.get(NUMBER_INFO_URL, () =>
          HttpResponse.json(
            rawNumberInfo({
              health_status: {
                can_send_message: 'LIMITED',
                entities: [
                  { entity_type: 'WABA', id: 'w1', can_send_message: 'AVAILABLE' },
                  {
                    entity_type: 'PHONE_NUMBER',
                    id: 'p1',
                    can_send_message: 'LIMITED',
                    additional_info: ['motivo certo'],
                  },
                ],
              },
            }),
          ),
        ),
      );

      const health = await new ZernioAccountsService(
        makeConfig(),
      ).fetchNumberInfo('acc_1');

      expect(health?.canSendMessageReason).toBe('motivo certo');
    });

    // O `nameRejectionReason` vem no TOPO do payload, e vem `null` quando a Meta
    // não expõe o código — um campo ausente não pode virar a string "null" no card.
    it('nameRejectionReason ausente/null → undefined', async () => {
      server.use(
        http.get(NUMBER_INFO_URL, () =>
          HttpResponse.json(rawNumberInfo({}, { nameRejectionReason: null })),
        ),
      );

      const health = await new ZernioAccountsService(
        makeConfig(),
      ).fetchNumberInfo('acc_1');

      expect(health?.nameRejectionReason).toBeUndefined();
    });

    // A saúde é DIAGNÓSTICO, não caminho crítico: o Zernio fora do ar (ou um
    // endpoint que suma numa versão futura da API) não pode derrubar a página
    // Canais — quem chama cai no fallback do `GET /accounts`.
    it.each([
      ['erro de rede', () => HttpResponse.error()],
      ['404', () => new HttpResponse(null, { status: 404 })],
      ['500', () => new HttpResponse(null, { status: 500 })],
    ])('devolve null em %s (nunca lança)', async (_label, respond) => {
      server.use(http.get(NUMBER_INFO_URL, respond));

      const health = await new ZernioAccountsService(
        makeConfig(),
      ).fetchNumberInfo('acc_1');

      expect(health).toBeNull();
    });

    it('sem ZERNIO_API_KEY → null, sem chamar a API', async () => {
      const health = await new ZernioAccountsService(
        makeConfig({ ZERNIO_API_KEY: undefined }),
      ).fetchNumberInfo('acc_1');

      expect(health).toBeNull();
    });
  });
});
