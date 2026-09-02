import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
  vi,
} from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import pino from 'pino';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import {
  GozapInstancesService,
  describeHttpError,
  gozapOwnerToE164,
} from './gozap-instances.service';
import { TOKEN_HEADER } from '../webhooks/gozap-webhooks.controller';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { WhatsappProvidersRepository } from './whatsapp-providers.repository';
import { ReconnectReplayService } from '../whatsapp-instances/reconnect-replay.service';
import { AuditService } from '../../shared/audit/audit.service';
import { InstanceNotFoundError } from '../whatsapp-instances/errors/instance.errors';
import {
  encryptToken,
  decryptToken,
} from '../../shared/crypto/gozap-token-cipher';

const BASE = 'https://acme.gozap.dev';
const KEY = 'a'.repeat(64); // 32 bytes em hex — mesma KEY do gozap-token-cipher.spec
const WEBHOOK_BASE_URL = 'https://picoa.example.com';
const WEBHOOK_TOKEN = 'whsecret123';

function makeConfig(o: Record<string, string | boolean | undefined> = {}) {
  const v: Record<string, string | boolean | undefined> = {
    GOZAP_BASE_URL: BASE,
    GOZAP_ADMIN_TOKEN: 'admtok',
    GOZAP_TOKEN_ENCRYPTION_KEY: KEY,
    GOZAP_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
    WEBHOOK_BASE_URL,
    ...o,
  };
  return { get: (k: string) => v[k] } as unknown as ConfigService;
}

// Molde: twilio-tier-sync.processor.spec.ts's makeChannel — objeto parcial +
// `as never` (bottom type, assignable a qualquer coisa) em vez de preencher
// os ~35 campos do model Channel.
function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ch1',
    name: 'Canal GoZap',
    provider: 'GOZAP',
    gozapInstanceId: 'gz1',
    gozapInstanceToken: null,
    isActive: true,
    isDefault: false,
    ...overrides,
  } as never;
}

/** Handler /webhook padrão (200 OK) — getConnectionInfo agora re-arma o webhook em toda chamada. */
function webhookHandler() {
  return http.post(`${BASE}/webhook`, () =>
    HttpResponse.json({ success: true }),
  );
}

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('GozapInstancesService', () => {
  let repo: MockProxy<WhatsappInstancesRepository>;
  let audit: MockProxy<AuditService>;
  let providersRepo: MockProxy<WhatsappProvidersRepository>;
  let replay: MockProxy<ReconnectReplayService>;
  let service: GozapInstancesService;

  /** Constrói o service com as mesmas dublês, variando só o env. */
  function build(env: Record<string, string | boolean | undefined> = {}) {
    return new GozapInstancesService(
      makeConfig(env),
      repo,
      audit,
      providersRepo,
      replay,
    );
  }

  beforeEach(() => {
    repo = mockDeep<WhatsappInstancesRepository>();
    audit = mockDeep<AuditService>();
    providersRepo = mockDeep<WhatsappProvidersRepository>();
    replay = mockDeep<ReconnectReplayService>();
    // Sem evento anterior é o estado real de um canal GOZAP recém-criado.
    providersRepo.findLastEvent.mockResolvedValue(null);
    // `mockDeep` devolve `undefined` por padrão; os métodos reais são `async` e
    // o service encadeia `.catch()` neles. Sem estes defaults o dublê quebraria
    // com TypeError num caminho que em produção nunca acontece.
    providersRepo.createEvent.mockResolvedValue({
      id: 'ev',
      instanceId: 'ch1',
      state: 'open',
      reasonCode: null,
      occurredAt: new Date(),
    });
    replay.replayWaitingFor.mockResolvedValue(undefined);
    repo.updateDeviceProfile.mockResolvedValue(undefined);
    service = build();
  });

  describe('createChannel', () => {
    beforeEach(() => {
      // Guard de duplicata: por padrão, sem canal ativo com o mesmo nome.
      // Os testes de duplicata sobrescrevem.
      repo.findActiveGozapChannelByName.mockResolvedValue(null);
    });

    it('cria a instância no GoZap, cifra o token ANTES de gravar e arma o webhook com a URL do segredo', async () => {
      let seenAdminToken: string | null = null;
      let webhookToken: string | null = null;

      let webhookBody: any = null;

      server.use(
        http.post(`${BASE}/instance/create`, async ({ request }) => {
          seenAdminToken = request.headers.get('admintoken');
          return HttpResponse.json(
            {
              success: true,
              token: 'inst_tok',
              instance: {
                id: 'gz1',
                name: 'Canal GoZap',
                status: 'disconnected',
                token: 'inst_tok',
                connection_mode: 'companion',
              },
            },
            { status: 201 },
          );
        }),
        http.post(`${BASE}/webhook`, async ({ request }) => {
          webhookToken = request.headers.get('token');
          webhookBody = await request.json();
          return HttpResponse.json({ success: true });
        }),
      );

      repo.createGozapChannel.mockResolvedValue(
        makeChannel({ gozapInstanceToken: 'CIPHERTEXT-PLACEHOLDER' }),
      );

      await service.createChannel({ name: 'Canal GoZap' });

      expect(seenAdminToken).toBe('admtok');

      expect(repo.createGozapChannel).toHaveBeenCalledTimes(1);
      const call = repo.createGozapChannel.mock.calls[0][0];
      expect(call.gozapInstanceId).toBe('gz1');
      // O valor gravado NÃO é o token cru — e decifra de volta para ele.
      expect(call.gozapInstanceToken).not.toBe('inst_tok');
      expect(decryptToken(call.gozapInstanceToken, KEY)).toBe('inst_tok');

      // Webhook armado com o token PLAINTEXT da instância (não o admintoken) e a
      // URL exata: WEBHOOK_BASE_URL + /webhooks/gozap?t=<GOZAP_WEBHOOK_TOKEN>.
      expect(webhookToken).toBe('inst_tok');
      // DUAS entradas. `excludeMessages: ['wasSentByApi']` impede o eco das
      // nossas mensagens no inbox, mas filtra a instância INTEIRA — inclusive
      // os recibos (`messages_update`) das nossas mensagens, que são os acks de
      // entrega. Incidente 2026-08-07: o registro do GoZap marcava a nossa
      // mensagem com `wasSentByApi: "True"` e nenhum recibo jamais chegou.
      // Precisa ser `{ webhooks: [...] }`: o ARRAY CRU é recusado com
      // `400 {"error":"invalid json body"}`, apesar de a doc do GoZap dizer
      // que ele é aceito (medido em produção 2026-08-07).
      expect(Array.isArray(webhookBody)).toBe(false);
      expect(Array.isArray(webhookBody.webhooks)).toBe(true);
      expect(webhookBody.webhooks).toHaveLength(2);
      const url = `${WEBHOOK_BASE_URL}/webhooks/gozap?t=${WEBHOOK_TOKEN}`;
      expect(
        webhookBody.webhooks.every((w: { url: string }) => w.url === url),
      ).toBe(true);
      expect(
        webhookBody.webhooks.every((w: { enabled: boolean }) => w.enabled),
      ).toBe(true);

      const msgs = webhookBody.webhooks.find((w: { events: string[] }) =>
        w.events.includes('messages'),
      );
      expect(msgs.events).toEqual(['messages']);
      expect(msgs.excludeMessages).toEqual(['wasSentByApi']);

      const acks = webhookBody.webhooks.find((w: { events: string[] }) =>
        w.events.includes('messages_update'),
      );
      expect(acks.events).toEqual(['messages_update', 'connection']);
      // O ponto do conserto: os acks NÃO podem carregar o filtro.
      expect(acks.excludeMessages).toBeUndefined();
    });

    /**
     * O OUTRO LADO DO C20: nós é que ARMAMOS a URL.
     *
     * Enquanto `resolveWebhookUrl` montar `?t=<segredo>` sem olhar para nada,
     * qualquer re-pareamento de canal pela UI reescreve a lista de webhooks do
     * GoZap (o POST /webhook SUBSTITUI a lista inteira) e devolve o segredo
     * para dentro da URL — apagando de quebra o cabeçalho que o operador tinha
     * configurado à mão no painel. Com a compat da query já DESLIGADA no
     * receptor, isso é pior que um vazamento: a URL re-armada carrega uma
     * credencial que o receptor não aceita mais, e TODA a entrada (ack,
     * mensagem recebida, opt-out de eleitor) morre em 401, em silêncio.
     *
     * Por isso o interruptor tem de valer para os DOIS lados: com
     * GOZAP_WEBHOOK_ALLOW_QUERY_TOKEN=false a URL registrada vai limpa e o
     * segredo viaja no cabeçalho da entrada de webhook.
     */
    it('com a compat da query DESLIGADA, arma a URL SEM o segredo e manda o segredo por cabeçalho', async () => {
      let webhookBody: any = null;
      server.use(
        http.post(`${BASE}/instance/create`, () =>
          HttpResponse.json(
            {
              success: true,
              token: 'inst_tok',
              instance: { id: 'gz1', status: 'disconnected' },
            },
            { status: 201 },
          ),
        ),
        http.post(`${BASE}/webhook`, async ({ request }) => {
          webhookBody = await request.json();
          return HttpResponse.json({ success: true });
        }),
      );
      repo.createGozapChannel.mockResolvedValue(
        makeChannel({ gozapInstanceToken: 'CIPHERTEXT-PLACEHOLDER' }),
      );
      // A ConfigService REAL devolve o booleano validado pelo zod — é o mesmo
      // valor que o controller do receptor compara com `!== false`.
      service = build({ GOZAP_WEBHOOK_ALLOW_QUERY_TOKEN: false });

      await service.createChannel({ name: 'Canal GoZap' });

      const urls = webhookBody.webhooks.map((w: { url: string }) => w.url);
      expect(urls).toEqual([
        `${WEBHOOK_BASE_URL}/webhooks/gozap`,
        `${WEBHOOK_BASE_URL}/webhooks/gozap`,
      ]);
      // Nem `?t=`, nem o segredo em lugar nenhum da URL.
      expect(JSON.stringify(urls)).not.toContain(WEBHOOK_TOKEN);
      // E a credencial não sumiu: ela vai no cabeçalho, em TODAS as entradas
      // (as duas existem por causa do `excludeMessages`; uma sem credencial
      // perderia justamente os acks).
      for (const w of webhookBody.webhooks) {
        expect(w.headers).toEqual({ 'X-Webhook-Token': WEBHOOK_TOKEN });
        // Amarra as duas pontas: o nome que MANDAMOS o GoZap usar tem de ser o
        // que o receptor LÊ (ele lê em caixa baixa, como o Node entrega).
        expect(Object.keys(w.headers)[0].toLowerCase()).toBe(TOKEN_HEADER);
      }
    });

    it('com a compat LIGADA (padrão) a URL continua com ?t= e sem cabeçalho', async () => {
      // O padrão não pode mudar: a URL gravada hoje no painel do GoZap é a com
      // `?t=`, e trocá-la por conta própria antes de o receptor e o painel
      // combinarem derruba a entrada inteira.
      let webhookBody: any = null;
      server.use(
        http.post(`${BASE}/instance/create`, () =>
          HttpResponse.json(
            {
              success: true,
              token: 'inst_tok',
              instance: { id: 'gz1', status: 'disconnected' },
            },
            { status: 201 },
          ),
        ),
        http.post(`${BASE}/webhook`, async ({ request }) => {
          webhookBody = await request.json();
          return HttpResponse.json({ success: true });
        }),
      );
      repo.createGozapChannel.mockResolvedValue(
        makeChannel({ gozapInstanceToken: 'CIPHERTEXT-PLACEHOLDER' }),
      );

      await service.createChannel({ name: 'Canal GoZap' });

      for (const w of webhookBody.webhooks) {
        expect(w.url).toBe(`${WEBHOOK_BASE_URL}/webhooks/gozap?t=${WEBHOOK_TOKEN}`);
        expect(w.headers).toBeUndefined();
      }
    });

    it('o retorno NUNCA contém o token — nem cru, nem cifrado', async () => {
      server.use(
        http.post(`${BASE}/instance/create`, () =>
          HttpResponse.json(
            {
              success: true,
              token: 'inst_tok',
              instance: { id: 'gz1', status: 'disconnected' },
            },
            { status: 201 },
          ),
        ),
        http.post(`${BASE}/webhook`, () =>
          HttpResponse.json({ success: true }),
        ),
      );
      repo.createGozapChannel.mockResolvedValue(
        makeChannel({ gozapInstanceToken: 'CIPHERTEXT-XYZ' }),
      );

      const result = await service.createChannel({ name: 'Canal GoZap' });

      expect(result).not.toHaveProperty('gozapInstanceToken');
      expect(result).not.toHaveProperty('apiKey');
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('inst_tok');
      expect(serialized).not.toContain('CIPHERTEXT-XYZ');
    });

    it('falha ao armar o webhook é best-effort — não impede a criação do canal', async () => {
      server.use(
        http.post(`${BASE}/instance/create`, () =>
          HttpResponse.json(
            {
              success: true,
              token: 'inst_tok',
              instance: { id: 'gz1', status: 'disconnected' },
            },
            { status: 201 },
          ),
        ),
        http.post(`${BASE}/webhook`, () =>
          HttpResponse.json({ error: 'boom' }, { status: 500 }),
        ),
      );
      repo.createGozapChannel.mockResolvedValue(
        makeChannel({ gozapInstanceToken: 'CIPHERTEXT' }),
      );

      await expect(
        service.createChannel({ name: 'Canal GoZap' }),
      ).resolves.toBeDefined();
    });

    it('GoZap sem token/id na resposta → falha explícita (não grava row incompleta)', async () => {
      server.use(
        http.post(`${BASE}/instance/create`, () =>
          HttpResponse.json({ success: true }, { status: 201 }),
        ),
      );

      await expect(
        service.createChannel({ name: 'Canal GoZap' }),
      ).rejects.toThrow();
      expect(repo.createGozapChannel).not.toHaveBeenCalled();
    });

    // Review fix (Important 1): sem este guard, um duplo-clique/retry cria
    // DUAS instâncias no GoZap para o mesmo nome (o @unique de
    // gozapInstanceId nunca pega a colisão — cada create do GoZap gera um id
    // diferente) e as rows órfãs se acumulam.
    it('nome já usado por um canal GOZAP ATIVO → rejeita ANTES de chamar o GoZap', async () => {
      let createCalls = 0;
      server.use(
        http.post(`${BASE}/instance/create`, () => {
          createCalls++;
          return HttpResponse.json(
            {
              success: true,
              token: 'inst_tok',
              instance: { id: 'gz1', status: 'disconnected' },
            },
            { status: 201 },
          );
        }),
      );
      repo.findActiveGozapChannelByName.mockResolvedValue(
        makeChannel({ id: 'existing-ch' }),
      );

      await expect(
        service.createChannel({ name: 'Canal GoZap' }),
      ).rejects.toMatchObject({ status: 400 });

      expect(createCalls).toBe(0);
      expect(repo.createGozapChannel).not.toHaveBeenCalled();
    });

    it('nome usado só por um canal GOZAP INATIVO (removido) → permite criar de novo', async () => {
      server.use(
        http.post(`${BASE}/instance/create`, () =>
          HttpResponse.json(
            {
              success: true,
              token: 'inst_tok2',
              instance: { id: 'gz2', status: 'disconnected' },
            },
            { status: 201 },
          ),
        ),
        webhookHandler(),
      );
      // findActiveGozapChannelByName é filtrado por isActive=true no
      // repositório — um canal removido não deve aparecer aqui. O mock
      // simula exatamente esse contrato devolvendo null.
      repo.findActiveGozapChannelByName.mockResolvedValue(null);
      repo.createGozapChannel.mockResolvedValue(
        makeChannel({ gozapInstanceId: 'gz2' }),
      );

      await expect(
        service.createChannel({ name: 'Canal GoZap' }),
      ).resolves.toBeDefined();
      expect(repo.createGozapChannel).toHaveBeenCalledTimes(1);
    });
  });

  describe('getConnectionInfo', () => {
    it('status "qr" → chama POST /instance/connect e devolve qrBase64 + state "connecting"', async () => {
      let statusToken: string | null = null;
      let connectToken: string | null = null;
      server.use(
        http.get(`${BASE}/instance/status`, ({ request }) => {
          statusToken = request.headers.get('token');
          return HttpResponse.json({
            success: true,
            instance: { id: 'gz1', status: 'qr' },
            runtime: { present: true, connected: false, logged_in: false },
          });
        }),
        http.post(`${BASE}/instance/connect`, ({ request }) => {
          connectToken = request.headers.get('token');
          return HttpResponse.json({
            success: true,
            instance: {
              id: 'gz1',
              status: 'qr',
              qrcode: 'data:image/png;base64,AAAA',
            },
            runtime: { present: true, connected: false, logged_in: false },
          });
        }),
        webhookHandler(),
      );
      repo.findById.mockResolvedValue(
        makeChannel({ gozapInstanceToken: encryptToken('inst_tok', KEY) }),
      );

      const info = await service.getConnectionInfo('ch1');

      expect(statusToken).toBe('inst_tok');
      expect(connectToken).toBe('inst_tok');
      expect(info.state).toBe('connecting');
      expect(info.qrBase64).toBe('data:image/png;base64,AAAA');
    });

    // Review fix (Critical 2): a versão anterior deste teste NÃO registrava
    // handler para /instance/connect e confiava no onUnhandledRequest:'error'
    // do msw para derrubar o teste se o service chamasse a rota mesmo assim.
    // Só que esse erro nasce DENTRO do interceptor — quem rejeita é a
    // requisição, e o catch do service (best-effort) o engolia: o teste
    // passava pelo motivo ERRADO. Agora é um handler real com contador —
    // prova de verdade, não dependência de efeito colateral do framework.
    it('status "connected" → mapeia para state "open" SEM chamar POST /instance/connect (contador, não onUnhandledRequest)', async () => {
      let connectCalls = 0;
      server.use(
        http.get(`${BASE}/instance/status`, () =>
          HttpResponse.json({
            success: true,
            instance: {
              id: 'gz1',
              status: 'connected',
              owner: '5592@s.whatsapp.net',
            },
            runtime: { present: true, connected: true, logged_in: true },
          }),
        ),
        http.post(`${BASE}/instance/connect`, () => {
          connectCalls++;
          return HttpResponse.json({
            success: true,
            instance: { id: 'gz1', status: 'connected' },
          });
        }),
        webhookHandler(),
      );
      repo.findById.mockResolvedValue(
        makeChannel({ gozapInstanceToken: encryptToken('inst_tok', KEY) }),
      );

      const info = await service.getConnectionInfo('ch1');

      expect(connectCalls).toBe(0);
      expect(info.state).toBe('open');
      expect(info.qrBase64).toBeUndefined();
    });

    it('canal sem gozapInstanceToken → state "close", SEM chamar NENHUMA rota do GoZap (contadores)', async () => {
      let statusCalls = 0;
      let connectCalls = 0;
      let webhookCalls = 0;
      server.use(
        http.get(`${BASE}/instance/status`, () => {
          statusCalls++;
          return HttpResponse.json({
            success: true,
            instance: { status: 'qr' },
          });
        }),
        http.post(`${BASE}/instance/connect`, () => {
          connectCalls++;
          return HttpResponse.json({
            success: true,
            instance: { status: 'qr' },
          });
        }),
        http.post(`${BASE}/webhook`, () => {
          webhookCalls++;
          return HttpResponse.json({ success: true });
        }),
      );
      repo.findById.mockResolvedValue(
        makeChannel({ gozapInstanceToken: null }),
      );

      const info = await service.getConnectionInfo('ch1');

      expect(info.state).toBe('close');
      expect(statusCalls).toBe(0);
      expect(connectCalls).toBe(0);
      expect(webhookCalls).toBe(0);
    });

    it('canal inexistente ou de outro provedor → InstanceNotFoundError', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.getConnectionInfo('nope')).rejects.toBeInstanceOf(
        InstanceNotFoundError,
      );

      repo.findById.mockResolvedValue(makeChannel({ provider: 'TWILIO' }));
      await expect(service.getConnectionInfo('ch1')).rejects.toBeInstanceOf(
        InstanceNotFoundError,
      );
    });

    // Review fix (Critical 2): GET /instance/status indisponível não pode
    // cair para POST /instance/connect — sem saber o estado atual, criar
    // sessão nova seria às cegas.
    it('GET /instance/status indisponível → NÃO tenta POST /instance/connect (não arrisca criar sessão às cegas)', async () => {
      let connectCalls = 0;
      server.use(
        http.get(`${BASE}/instance/status`, () =>
          HttpResponse.json({ error: 'boom' }, { status: 500 }),
        ),
        http.post(`${BASE}/instance/connect`, () => {
          connectCalls++;
          return HttpResponse.json({
            success: true,
            instance: { status: 'qr' },
          });
        }),
        webhookHandler(),
      );
      repo.findById.mockResolvedValue(
        makeChannel({ gozapInstanceToken: encryptToken('inst_tok', KEY) }),
      );

      const info = await service.getConnectionInfo('ch1');

      expect(connectCalls).toBe(0);
      expect(info.state).toBe('close'); // sem cache prévio, fallback é close
    });

    // Review fix (Critical 2): cache de QR — POST /instance/connect cria uma
    // sessão nova no GoZap a cada chamada (mesmo motivo do qrCache do
    // Evolution). Duas chamadas seguidas de getConnectionInfo enquanto o
    // status continua "qr" devem reusar o QR já obtido, não recriar sessão.
    //
    // Este teste FALHA sem o cache: connectCalls seria 2. Verificado
    // manualmente comentando o bloco de cache em gozap-instances.service.ts
    // e rodando esta suíte — RED confirmado, depois revertido.
    it('cache de QR: duas chamadas seguidas com status "qr" chamam POST /instance/connect só UMA vez', async () => {
      let connectCalls = 0;
      server.use(
        http.get(`${BASE}/instance/status`, () =>
          HttpResponse.json({
            success: true,
            instance: { id: 'gz1', status: 'qr' },
            runtime: { present: true, connected: false, logged_in: false },
          }),
        ),
        http.post(`${BASE}/instance/connect`, () => {
          connectCalls++;
          return HttpResponse.json({
            success: true,
            instance: {
              id: 'gz1',
              status: 'qr',
              qrcode: 'data:image/png;base64,AAAA',
            },
            runtime: { present: true, connected: false, logged_in: false },
          });
        }),
        webhookHandler(),
      );
      repo.findById.mockResolvedValue(
        makeChannel({ gozapInstanceToken: encryptToken('inst_tok', KEY) }),
      );

      const first = await service.getConnectionInfo('ch1');
      const second = await service.getConnectionInfo('ch1');

      expect(connectCalls).toBe(1);
      expect(first.qrBase64).toBe('data:image/png;base64,AAAA');
      expect(second.qrBase64).toBe('data:image/png;base64,AAAA');
      expect(second.state).toBe('connecting');
    });

    // Review fix (Important 2): se o armWebhook da CRIAÇÃO falhou em silêncio,
    // o canal nascia sem receptor de ack e nada re-tentava. getConnectionInfo
    // agora re-arma (idempotente — o GoZap substitui a lista inteira) a cada
    // poll de QR, autocurando esse caso.
    it('re-arma o webhook a cada chamada (self-heal, idempotente)', async () => {
      let webhookCalls = 0;
      let webhookToken: string | null = null;
      server.use(
        http.get(`${BASE}/instance/status`, () =>
          HttpResponse.json({
            success: true,
            instance: { id: 'gz1', status: 'qr' },
            runtime: { present: true, connected: false, logged_in: false },
          }),
        ),
        http.post(`${BASE}/instance/connect`, () =>
          HttpResponse.json({
            success: true,
            instance: {
              id: 'gz1',
              status: 'qr',
              qrcode: 'data:image/png;base64,AAAA',
            },
          }),
        ),
        http.post(`${BASE}/webhook`, ({ request }) => {
          webhookCalls++;
          webhookToken = request.headers.get('token');
          return HttpResponse.json({ success: true });
        }),
      );
      repo.findById.mockResolvedValue(
        makeChannel({ gozapInstanceToken: encryptToken('inst_tok', KEY) }),
      );

      await service.getConnectionInfo('ch1');

      expect(webhookCalls).toBe(1);
      expect(webhookToken).toBe('inst_tok');
    });
  });

  /**
   * INCIDENTE DE PRODUÇÃO (2026-08-07, canal cmsj0ub8h0182l401bak4ee84).
   *
   * O cliente pareou o número (o GoZap confirmou `status:"connected"`,
   * `runtime.logged_in:true`, owner 559286550102) e o canal ficou INUTILIZÁVEL:
   * no assistente de campanha aparecia como "desconectada", com o rádio
   * desabilitado. Causa: `GOZAP` é `sessionBased`, e o roteador
   * (`whatsapp-instance-router.service.ts#isInstanceOnline`) exige uma linha
   * `WhatsappConnectionEvent(state='open')` — que NADA no orgamind escrevia para
   * GOZAP. Este service LIA o estado ao vivo e devolvia só na resposta HTTP.
   *
   * Todos os testes abaixo falham contra o código anterior: `providersRepo` e
   * `repo.updateDeviceProfile` nunca eram tocados.
   */
  describe('persistência do estado da sessão (o canal pareado precisa ficar UTILIZÁVEL)', () => {
    /** Payload REAL observado em produção — repare no `:1` (índice do aparelho) no owner. */
    function connectedStatus() {
      return http.get(`${BASE}/instance/status`, () =>
        HttpResponse.json({
          success: true,
          instance: {
            id: 'gz1',
            status: 'connected',
            owner: '559286550102:1@s.whatsapp.net',
            profileName: 'Matheus Garcia',
            profilePicUrl: 'https://pps.whatsapp.net/v/foto.jpg',
          },
          runtime: { present: true, connected: true, logged_in: true },
        }),
      );
    }

    beforeEach(() => {
      repo.findById.mockResolvedValue(
        makeChannel({ gozapInstanceToken: encryptToken('inst_tok', KEY) }),
      );
    });

    it('sessão conectada → grava WhatsappConnectionEvent("open") (sem ele o roteador nunca libera envio)', async () => {
      server.use(connectedStatus(), webhookHandler());

      const info = await service.getConnectionInfo('ch1');

      expect(info.state).toBe('open');
      expect(providersRepo.createEvent).toHaveBeenCalledTimes(1);
      expect(providersRepo.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'ch1', state: 'open' }),
      );
    });

    it('sessão conectada → grava phoneE164/profileName e REINICIA a rampa de aquecimento (número novo)', async () => {
      server.use(connectedStatus(), webhookHandler());

      await service.getConnectionInfo('ch1');

      expect(repo.updateDeviceProfile).toHaveBeenCalledTimes(1);
      const [id, profile] = repo.updateDeviceProfile.mock.calls[0];
      expect(id).toBe('ch1');
      // `:1` é o índice do aparelho — cortar só no `@` produziria "+559286550102:1".
      expect(profile.phoneE164).toBe('+559286550102');
      expect(profile.profileName).toBe('Matheus Garcia');
      expect(profile.profilePictureUrl).toBe(
        'https://pps.whatsapp.net/v/foto.jpg',
      );
      // GoZap é não-oficial como o Evolution: pareamento novo reinicia a rampa.
      expect(profile.warmupStartedAt).toBeInstanceOf(Date);
    });

    it('transição para "open" destrava as mensagens paradas em WAITING_INSTANCE', async () => {
      server.use(connectedStatus(), webhookHandler());

      await service.getConnectionInfo('ch1');

      expect(replay.replayWaitingFor).toHaveBeenCalledWith('ch1');
    });

    it('já estava "open" → NÃO grava evento repetido, mas AINDA tenta destravar a fila', async () => {
      providersRepo.findLastEvent.mockResolvedValue({
        id: 'ev1',
        instanceId: 'ch1',
        state: 'open',
        reasonCode: null,
        occurredAt: new Date(),
      });
      repo.findById.mockResolvedValue(
        makeChannel({
          gozapInstanceToken: encryptToken('inst_tok', KEY),
          phoneE164: '+559286550102',
          profileName: 'Matheus Garcia',
          profilePictureUrl: 'https://pps.whatsapp.net/v/foto.jpg',
        }),
      );
      server.use(connectedStatus(), webhookHandler());

      await service.getConnectionInfo('ch1');

      expect(providersRepo.createEvent).not.toHaveBeenCalled();
      // Nada mudou no perfil — não reescreve (senão a rampa reiniciaria à toa).
      expect(repo.updateDeviceProfile).not.toHaveBeenCalled();
      // Mas o replay é dirigido pelo ESTADO, não pela transição: se ele tivesse
      // falhado na única transição, o evento 'open' já gravado faria todo tick
      // seguinte concluir "sem mudança" e as mensagens ficariam presas para
      // sempre. É idempotente — o segundo chamador reivindica 0 linhas.
      expect(replay.replayWaitingFor).toHaveBeenCalledWith('ch1');
    });

    it('replay que falha NÃO derruba a resposta nem some em silêncio', async () => {
      const errorSpy = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      replay.replayWaitingFor.mockRejectedValue(new Error('pool esgotado'));
      server.use(connectedStatus(), webhookHandler());

      await expect(service.getConnectionInfo('ch1')).resolves.toEqual({
        state: 'open',
      });
      // O catch do replay é assíncrono (fire-and-forget) — deixa a microtask correr.
      await Promise.resolve();
      await Promise.resolve();

      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('200 que NÃO entendemos não vira "close" — não derruba um canal saudável', async () => {
      server.use(
        // O GoZap responde 200 para coisas que não honra (foi assim que ele
        // aceitou um webhook inalcançável). Um corpo sem `instance.status`
        // reconhecível é "não sei", não "desconectado".
        http.get(`${BASE}/instance/status`, () =>
          HttpResponse.json({ success: false, error: 'algo deu errado' }),
        ),
        http.post(`${BASE}/instance/connect`, () =>
          HttpResponse.json({ success: true, instance: { id: 'gz1' } }),
        ),
        webhookHandler(),
      );

      await service.getConnectionInfo('ch1');

      expect(providersRepo.createEvent).not.toHaveBeenCalled();
      expect(replay.replayWaitingFor).not.toHaveBeenCalled();
    });

    it('reconcileConnection com 200 incompreensível NÃO persiste nada', async () => {
      server.use(
        http.get(`${BASE}/instance/status`, () =>
          HttpResponse.json({ instance: { id: 'gz1', status: 'quem-sabe' } }),
        ),
        webhookHandler(),
      );

      await expect(service.reconcileConnection('ch1')).resolves.toBeNull();
      expect(providersRepo.createEvent).not.toHaveBeenCalled();
    });

    /**
     * INCIDENTE 2026-08-11 — o canal de produção ficou 15h com o reconciliador
     * logando `falhas=1` a cada 60s e NENHUM evento gravado, porque o GoZap
     * devolveu um status que não existe em lugar nenhum da doc dele
     * (`grep -i hibernat` nos 296 endpoints do openapi: zero ocorrências).
     *
     * A instância hiberna SOZINHA, sem despareamento: `owner` e `profileName`
     * continuam lá, mas `runtime.logged_in` é false e nada sai. Como
     * `hibernated` não estava em `KNOWN_GOZAP_STATUS`, `readLiveState` devolvia
     * "não sei" — a decisão CERTA para um valor desconhecido — e o banco
     * seguia com o `open` de três dias antes. O orgamind achava o canal online.
     *
     * Corpo abaixo COPIADO da resposta real de produção (segredos removidos).
     */
    it('status "hibernated" (indocumentado, visto em produção) → grava "close"', async () => {
      server.use(
        http.get(`${BASE}/instance/status`, () =>
          HttpResponse.json({
            success: true,
            instance: {
              id: 'gz1',
              status: 'hibernated',
              owner: '559286550102:1@s.whatsapp.net',
              profileName: 'Matheus Garcia',
              lastDisconnect: 1786407360949,
              lastDisconnectReason: 'client not running',
            },
            runtime: { present: false, connected: false, logged_in: false },
          }),
        ),
        webhookHandler(),
      );

      await expect(service.reconcileConnection('ch1')).resolves.toBe('close');
      expect(providersRepo.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'ch1', state: 'close' }),
      );
      // Hibernada NÃO é conectada: soltar a fila aqui mandaria mensagem por uma
      // sessão que não existe.
      expect(replay.replayWaitingFor).not.toHaveBeenCalled();
    });

    it('sessão caída → grava "close" (é assim que o orgamind PARA de mandar por um número morto)', async () => {
      server.use(
        http.get(`${BASE}/instance/status`, () =>
          HttpResponse.json({
            success: true,
            instance: { id: 'gz1', status: 'disconnected' },
            runtime: { present: false, connected: false, logged_in: false },
          }),
        ),
        http.post(`${BASE}/instance/connect`, () =>
          HttpResponse.json({
            success: true,
            instance: { id: 'gz1', status: 'disconnected' },
          }),
        ),
        webhookHandler(),
      );

      await service.getConnectionInfo('ch1');

      expect(providersRepo.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'ch1', state: 'close' }),
      );
      expect(replay.replayWaitingFor).not.toHaveBeenCalled();
    });

    it('estado transitório "qr" NÃO vira evento (o poll do QR é de 3s — viraria ruído)', async () => {
      server.use(
        http.get(`${BASE}/instance/status`, () =>
          HttpResponse.json({
            success: true,
            instance: { id: 'gz1', status: 'qr' },
          }),
        ),
        http.post(`${BASE}/instance/connect`, () =>
          HttpResponse.json({
            success: true,
            instance: { id: 'gz1', status: 'qr', qrcode: 'QR' },
          }),
        ),
        webhookHandler(),
      );

      const info = await service.getConnectionInfo('ch1');

      expect(info.state).toBe('connecting');
      expect(providersRepo.createEvent).not.toHaveBeenCalled();
    });

    it('falha de escrita no banco NÃO derruba a resposta de QR (best-effort)', async () => {
      providersRepo.createEvent.mockRejectedValue(new Error('banco fora'));
      server.use(connectedStatus(), webhookHandler());

      await expect(service.getConnectionInfo('ch1')).resolves.toEqual({
        state: 'open',
      });
    });

    it('reconcileConnection converge o banco SEM criar sessão (nunca chama POST /instance/connect)', async () => {
      let connectCalls = 0;
      server.use(
        connectedStatus(),
        http.post(`${BASE}/instance/connect`, () => {
          connectCalls++;
          return HttpResponse.json({ success: true, instance: { id: 'gz1' } });
        }),
        webhookHandler(),
      );

      const state = await service.reconcileConnection('ch1');

      expect(state).toBe('open');
      expect(connectCalls).toBe(0);
      expect(providersRepo.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'open' }),
      );
      expect(repo.updateDeviceProfile).toHaveBeenCalled();
    });

    it('reconcileConnection ignora canal de outro provedor / sem token', async () => {
      repo.findById.mockResolvedValue(makeChannel({ provider: 'TWILIO' }));
      await expect(service.reconcileConnection('ch1')).resolves.toBeNull();

      repo.findById.mockResolvedValue(
        makeChannel({ gozapInstanceToken: null }),
      );
      await expect(service.reconcileConnection('ch1')).resolves.toBeNull();

      expect(providersRepo.createEvent).not.toHaveBeenCalled();
    });

    it('owner malformado → NÃO inventa telefone (mantém o gravado)', () => {
      expect(gozapOwnerToE164('559286550102:1@s.whatsapp.net')).toBe(
        '+559286550102',
      );
      expect(gozapOwnerToE164('559286550102@s.whatsapp.net')).toBe(
        '+559286550102',
      );
      expect(gozapOwnerToE164(undefined)).toBeNull();
      expect(gozapOwnerToE164('')).toBeNull();
      expect(gozapOwnerToE164('@s.whatsapp.net')).toBeNull();
      expect(gozapOwnerToE164('123@s.whatsapp.net')).toBeNull(); // curto demais para E.164
    });
  });

  /**
   * INCIDENTE DE PRODUÇÃO (2026-08-07), a metade SILENCIOSA.
   *
   * `armWebhook` montava a URL a partir de `WEBHOOK_BASE_URL`, que é interna
   * POR PROJETO (`.env.prod.example`: "internal Docker DNS"). Em produção o
   * orgamind registrou no GoZap `http://api:3000/webhooks/gozap?t=…` — nome de
   * serviço do docker-compose, que um SaaS de terceiro nunca resolve. O GoZap
   * RESPONDE 200 ao registrar (só descobriria ao entregar), então o
   * `.catch()` best-effort nunca disparou: 17h de log sem uma linha
   * `level>=40`, e zero acks / zero mensagens recebidas / zero opt-out.
   *
   * O teste feliz que já existia (`…arma o webhook com a URL do segredo`) é
   * TAUTOLÓGICO: ele deriva a expectativa da mesma constante que alimenta o
   * ConfigService, então `http://api:3000` passaria verde.
   */
  describe('armWebhook: a URL entregue a um provedor EXTERNO precisa ser alcançável pela internet', () => {
    beforeEach(() => {
      repo.findActiveGozapChannelByName.mockResolvedValue(null);
      repo.createGozapChannel.mockResolvedValue(makeChannel());
    });

    function createInstanceHandler() {
      return http.post(`${BASE}/instance/create`, () =>
        HttpResponse.json(
          {
            success: true,
            token: 'inst_tok',
            instance: { id: 'gz1', status: 'disconnected' },
          },
          { status: 201 },
        ),
      );
    }

    it.each([
      [
        'http://api:3000',
        'nome de serviço do compose — o valor exato de produção',
      ],
      ['http://localhost:3000', 'loopback'],
      ['http://worker:3000', 'rótulo único, sem domínio'],
      ['http://10.0.0.5:3000', 'IP privado RFC1918'],
      ['http://127.0.0.1:3000', 'IP de loopback'],
      ['https://picoa.internal', 'sufixo de rede local'],
    ])(
      'base %s (%s) → NÃO registra o webhook e grita em logger.error',
      async (baseUrl) => {
        const errorSpy = vi
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);
        let postedUrl: string | null = null;
        server.use(
          createInstanceHandler(),
          // O GoZap ACEITA qualquer URL — por isso só um guard NOSSO pega isto.
          http.post(`${BASE}/webhook`, async ({ request }) => {
            postedUrl = ((await request.json()) as Array<{ url: string }>)[0]
              .url;
            return HttpResponse.json({ success: true });
          }),
        );
        service = build({
          WEBHOOK_BASE_URL: baseUrl,
          PUBLIC_WEBHOOK_BASE_URL: undefined,
        });

        // O canal AINDA é criado: o operador consegue parear e corrigir o env
        // depois. O que muda é que a URL inalcançável nunca é registrada.
        await expect(
          service.createChannel({ name: 'Canal GoZap' }),
        ).resolves.toBeDefined();

        expect(postedUrl).toBeNull();
        expect(errorSpy).toHaveBeenCalled();
        const logged = JSON.stringify(errorSpy.mock.calls);
        expect(logged).toContain('PUBLIC_WEBHOOK_BASE_URL');
        // O diagnóstico não pode virar um novo vazamento de segredo.
        expect(logged).not.toContain(WEBHOOK_TOKEN);
        errorSpy.mockRestore();
      },
    );

    it('PUBLIC_WEBHOOK_BASE_URL tem precedência sobre a WEBHOOK_BASE_URL interna', async () => {
      let postedUrl: string | null = null;
      server.use(
        createInstanceHandler(),
        http.post(`${BASE}/webhook`, async ({ request }) => {
          postedUrl = (
            (await request.json()) as { webhooks: Array<{ url: string }> }
          ).webhooks[0].url;
          return HttpResponse.json({ success: true });
        }),
      );
      service = build({
        WEBHOOK_BASE_URL: 'http://api:3000',
        PUBLIC_WEBHOOK_BASE_URL: 'https://picoa.app.br/api',
      });

      await service.createChannel({ name: 'Canal GoZap' });

      expect(postedUrl).toBe(
        `https://picoa.app.br/api/webhooks/gozap?t=${WEBHOOK_TOKEN}`,
      );
    });

    it('base colada com querystring é normalizada (senão TODO webhook volta 401)', async () => {
      let postedUrl: string | null = null;
      server.use(
        createInstanceHandler(),
        http.post(`${BASE}/webhook`, async ({ request }) => {
          postedUrl = (
            (await request.json()) as { webhooks: Array<{ url: string }> }
          ).webhooks[0].url;
          return HttpResponse.json({ success: true });
        }),
      );
      // O painel do GoZap exibe a URL COMPLETA; colá-la aqui é o erro natural.
      // Sem normalizar, o `t` que o receptor lê viraria "COLADO/webhooks/gozap?t=COLADO".
      service = build({
        PUBLIC_WEBHOOK_BASE_URL:
          'https://picoa.app.br/api/webhooks/gozap?t=COLADO',
      });

      await service.createChannel({ name: 'Canal GoZap' });

      expect(postedUrl).toBe(
        `https://picoa.app.br/api/webhooks/gozap?t=${WEBHOOK_TOKEN}`,
      );
    });

    it('segredo embutido numa base reprovada NÃO vai para o log', async () => {
      const errorSpy = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      server.use(createInstanceHandler());
      // Base não-pública E carregando segredo: o guard reprova e loga.
      service = build({
        WEBHOOK_BASE_URL: 'http://api:3000/webhooks/gozap?t=SEGREDO-NAO-LOGAR',
        PUBLIC_WEBHOOK_BASE_URL: undefined,
      });

      await service.createChannel({ name: 'Canal GoZap' });

      const logged = JSON.stringify(errorSpy.mock.calls);
      expect(logged).not.toContain('SEGREDO-NAO-LOGAR');
      expect(logged).toContain('http://api:3000'); // a origem, sim — ela diagnostica
      errorSpy.mockRestore();
    });

    it('o alarme de webhook mal configurado é estrangulado (não vira 1440 linhas/dia)', async () => {
      const errorSpy = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      server.use(
        http.get(`${BASE}/instance/status`, () =>
          HttpResponse.json({
            success: true,
            instance: { id: 'gz1', status: 'qr' },
          }),
        ),
        http.post(`${BASE}/instance/connect`, () =>
          HttpResponse.json({
            success: true,
            instance: { id: 'gz1', status: 'qr' },
          }),
        ),
      );
      service = build({
        WEBHOOK_BASE_URL: 'http://api:3000',
        PUBLIC_WEBHOOK_BASE_URL: undefined,
      });
      repo.findById.mockResolvedValue(
        makeChannel({ gozapInstanceToken: encryptToken('inst_tok', KEY) }),
      );

      await service.reconcileConnection('ch1');
      await service.reconcileConnection('ch1');
      await service.reconcileConnection('ch1');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    });

    it('barra final na base não vira barra dupla na URL registrada', async () => {
      let postedUrl: string | null = null;
      server.use(
        createInstanceHandler(),
        http.post(`${BASE}/webhook`, async ({ request }) => {
          postedUrl = (
            (await request.json()) as { webhooks: Array<{ url: string }> }
          ).webhooks[0].url;
          return HttpResponse.json({ success: true });
        }),
      );
      service = build({ PUBLIC_WEBHOOK_BASE_URL: 'https://picoa.app.br/api/' });

      await service.createChannel({ name: 'Canal GoZap' });

      expect(postedUrl).toBe(
        `https://picoa.app.br/api/webhooks/gozap?t=${WEBHOOK_TOKEN}`,
      );
    });
  });

  describe('disconnect / remove', () => {
    it('disconnect chama POST /instance/disconnect com o token da instância', async () => {
      let seenToken: string | null = null;
      server.use(
        http.post(`${BASE}/instance/disconnect`, ({ request }) => {
          seenToken = request.headers.get('token');
          return HttpResponse.json({ success: true });
        }),
      );
      repo.findById.mockResolvedValue(
        makeChannel({ gozapInstanceToken: encryptToken('inst_tok', KEY) }),
      );

      await service.disconnect('ch1');

      expect(seenToken).toBe('inst_tok');
    });

    it('disconnect grava o evento "close" NA HORA (não espera o tick de 60s)', async () => {
      server.use(
        http.post(`${BASE}/instance/disconnect`, () =>
          HttpResponse.json({ success: true }),
        ),
      );
      repo.findById.mockResolvedValue(
        makeChannel({ gozapInstanceToken: encryptToken('inst_tok', KEY) }),
      );

      await service.disconnect('ch1');

      // Sem isto o último evento continua 'open' por até 60s e o roteador
      // entrega para uma sessão morta — o GoZap devolve `gozap.not_connected`,
      // que NÃO está na guarda de reparque do send-message.processor (escopada
      // a `evolution.not_connected`), então a mensagem morre FAILED.
      expect(providersRepo.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'ch1', state: 'close' }),
      );
    });

    it('remove chama DELETE /instance e soft-deleta a row', async () => {
      server.use(
        http.delete(`${BASE}/instance`, () =>
          HttpResponse.json({ success: true }),
        ),
      );
      repo.findById.mockResolvedValue(
        makeChannel({ gozapInstanceToken: encryptToken('inst_tok', KEY) }),
      );
      repo.softDelete.mockResolvedValue(makeChannel({ isActive: false }));

      await service.remove('ch1');

      expect(repo.softDelete).toHaveBeenCalledWith('ch1');
    });
  });

  // Review fix (Critical 1): o serializer de erro padrão do pino percorre o
  // AxiosError inteiro — inclusive `err.config.headers`, onde viaja o token
  // PLAINTEXT da instância. `this.logger.warn({ err, ... })` (objeto cru)
  // vazava o segredo em texto claro no log agregado. A correção troca por
  // `describeHttpError(err)` (uma string-resumo) em todo `logger.warn` desta
  // classe. Os dois testes abaixo provam isso em duas camadas: a unidade
  // (describeHttpError nunca inclui headers/config) e o pipeline completo
  // (um pino real, alimentado com exatamente o que este service loga, nunca
  // escreve o token) — reproduzindo e fechando o repro do revisor.
  describe('o token nunca é logado em claro', () => {
    it('describeHttpError nunca inclui o corpo/headers da request — só status ou mensagem', () => {
      const withTokenInHeaders = {
        isAxiosError: true,
        message: 'Request failed',
        config: {
          url: '/instance/status',
          headers: { token: 'PLAINTEXT_INSTANCE_TOKEN' },
        },
        response: { status: 500, data: { error: 'boom' } },
      };
      const summary = describeHttpError(withTokenInHeaders);
      expect(summary).toBe('HTTP 500');
      expect(summary).not.toContain('PLAINTEXT_INSTANCE_TOKEN');

      const networkError = {
        isAxiosError: true,
        code: 'ECONNREFUSED',
        message: 'connect ECONNREFUSED',
        config: {
          url: '/instance/connect',
          headers: { token: 'OUTRO_TOKEN_SECRETO' },
        },
      };
      const summary2 = describeHttpError(networkError);
      expect(summary2).not.toContain('OUTRO_TOKEN_SECRETO');
    });

    it('reproduz o repro do revisor com um pino real: o AxiosError cru vazava o token via err.config.headers — describeHttpError fecha o vazamento', () => {
      const logs: string[] = [];
      const logger = pino({}, { write: (msg: string) => logs.push(msg) });

      // Forma exata de um AxiosError com o token no header da instância —
      // é o que qualquer chamada deste service produz quando o GoZap falha.
      const realisticAxiosError = {
        isAxiosError: true,
        code: undefined,
        message: 'Request failed with status code 500',
        config: {
          url: '/instance/status',
          method: 'get',
          headers: {
            'Content-Type': 'application/json',
            token: 'PLAINTEXT_INSTANCE_TOKEN',
          },
        },
        response: { status: 500, data: { error: 'boom' } },
      };

      // ANTES da correção: this.logger.warn({ err: realisticAxiosError, channelId }, msg)
      // vazava. DEPOIS: this.logger.warn({ err: describeHttpError(err), channelId }, msg).
      logger.warn(
        { err: describeHttpError(realisticAxiosError), channelId: 'ch1' },
        'gozap: falha ao consultar /instance/status',
      );

      const output = logs.join('\n');
      expect(output).not.toContain('PLAINTEXT_INSTANCE_TOKEN');
      expect(output).toContain('HTTP 500');
    });

    it('todo logger.warn do service recebe só resumos — nunca o AxiosError bruto (spy no Logger real da classe)', async () => {
      const warnSpy = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      server.use(
        http.get(`${BASE}/instance/status`, () =>
          HttpResponse.json({ error: 'boom' }, { status: 500 }),
        ),
        http.post(`${BASE}/webhook`, () =>
          HttpResponse.json({ error: 'boom' }, { status: 500 }),
        ),
      );
      repo.findById.mockResolvedValue(
        makeChannel({
          gozapInstanceToken: encryptToken('inst_tok_super_secret', KEY),
        }),
      );

      await service.getConnectionInfo('ch1');

      expect(warnSpy).toHaveBeenCalled();
      for (const call of warnSpy.mock.calls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain('inst_tok_super_secret');
        // Prova a causa raiz, não só o sintoma: nenhum objeto aninhado tipo
        // AxiosError (headers/config) chega ao logger — só strings resumidas.
        expect(serialized).not.toContain('"headers"');
        expect(serialized).not.toContain('"config"');
      }

      warnSpy.mockRestore();
    });
  });
});
