import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { type AxiosInstance } from 'axios';
import type { Channel } from '@prisma/client';
import type { Env } from '../../shared/config/env.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { DomainError } from '../../shared/errors/domain.error';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { InstanceNotFoundError } from '../whatsapp-instances/errors/instance.errors';
import { ReconnectReplayService } from '../whatsapp-instances/reconnect-replay.service';
import { WhatsappProvidersRepository } from './whatsapp-providers.repository';
import { ProviderNotConfiguredError } from './provider-registry.service';
import {
  encryptToken,
  decryptToken,
} from '../../shared/crypto/gozap-token-cipher';
import { isExternallyReachableUrl } from '../../shared/config/public-url';
import type { ConnectionState } from './ports/message-provider.port';

// A5 / be-gozap: never return either secret to a caller — same rationale as
// apiKey (be-whatsapp-003) applied to the GoZap instance token.
type SafeGozapChannel = Omit<Channel, 'apiKey' | 'gozapInstanceToken'>;

type GozapInstanceInfo = {
  id?: string;
  status?: string;
  qrcode?: string;
  /** JID do aparelho pareado: `559286550102:1@s.whatsapp.net`. */
  owner?: string | null;
  profileName?: string | null;
  profilePicUrl?: string | null;
};

/**
 * O que o GoZap sabe sobre a sessão AGORA — o que precisa virar linha no banco.
 * `state: null` significa "não deu para saber" (ver `readLiveState`), e nunca
 * pode ser confundido com `close`.
 */
type GozapLiveState = {
  state: ConnectionState | null;
  phoneE164: string | null;
  profileName: string | null;
  profilePictureUrl: string | null;
};

type GozapRuntimeInfo = {
  present?: boolean;
  connected?: boolean;
  logged_in?: boolean;
};

type GozapCreateInstanceResponse = {
  success?: boolean;
  token?: string;
  instance?: GozapInstanceInfo & { token?: string; name?: string };
};

type GozapStatusOrConnectResponse = {
  success?: boolean;
  instance?: GozapInstanceInfo;
  runtime?: GozapRuntimeInfo;
};

/**
 * Contrato orgamind `state`: `connected` → `open`; `qr`/`connecting` →
 * `connecting`; qualquer outro valor (`disconnected`, ausente, desconhecido)
 * → `close`. Espelha exatamente o mapeamento resolvido no brief da Task 7.
 */
function mapConnectionState(status: string | undefined): ConnectionState {
  if (status === 'connected') return 'open';
  if (status === 'qr' || status === 'connecting') return 'connecting';
  return 'close';
}

/**
 * `owner` do GoZap chega como `559286550102:1@s.whatsapp.net` — o `:1` é o
 * índice do APARELHO. O caminho equivalente do Evolution
 * (`whatsapp-instances.service.ts`) corta só no `@` porque o `ownerJid` de lá
 * não traz o sufixo; fazer o mesmo aqui produziria `+559286550102:1`, que não
 * é E.164 e envenenaria a coluna. Corta nos dois e valida o comprimento —
 * um `owner` malformado precisa virar `null` (mantém o valor gravado), nunca
 * um telefone inventado.
 */
export function gozapOwnerToE164(
  owner: string | null | undefined,
): string | null {
  if (!owner) return null;
  const digits = owner.split('@')[0].split(':')[0].replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/** O caminho do receptor de webhook do GoZap, relativo à base pública. */
const WEBHOOK_PATH = '/webhooks/gozap';

/** Os `instance.status` que o GoZap documenta e que sabemos traduzir. */
const KNOWN_GOZAP_STATUS = new Set([
  'connected',
  'disconnected',
  'qr',
  'connecting',
  // `hibernated` NÃO está documentado em lugar nenhum do GoZap (`grep -i
  // hibernat` nos 296 endpoints do openapi: zero). Foi observado em PRODUÇÃO
  // em 2026-08-11: a instância hiberna sozinha, sem despareamento — `owner` e
  // `profileName` continuam preenchidos, `lastDisconnectReason` vira "client
  // not running" e `runtime.logged_in` vira false. É `close` para todo efeito
  // (nada sai por ela), e reconhecê-lo aqui é o que faz o banco parar de
  // mentir: enquanto era desconhecido, `readLiveState` devolvia "não sei" — o
  // certo para um valor novo — e o último evento gravado continuava `open`,
  // de dias antes. O reconciliador ficou 15h logando `falhas=1` a cada 60s
  // enquanto o orgamind achava o canal online.
  //
  // O despertar NÃO é feito aqui: `POST /instance/connect` CRIA sessão, e este
  // caminho roda de 60 em 60s. Quem acorda é o diálogo de QR (ação explícita
  // do operador), que já chama esse endpoint — e a instância volta sem QR
  // novo, porque o login continua de pé do lado do GoZap.
  'hibernated',
]);

/**
 * `GET /instance/status` → o estado que o orgamind precisa persistir.
 *
 * `runtime.logged_in` vence o `instance.status` quando diverge: o runtime é o
 * socket vivo, o status é a última escrita do GoZap no próprio banco dele.
 *
 * `state: null` = **não sei**, e é diferente de `close`. Um 200 cujo corpo não
 * reconhecemos (`{success:false}`, campo renomeado, resposta truncada) NÃO pode
 * virar um `close` persistido: isso derrubaria um canal saudável e pararia todo
 * envio em `WAITING_INSTANCE`. É o mesmo desenho do caminho do Evolution, que
 * devolve `null` no desconhecido (`evolution-api.adapter.ts`) e faz o
 * reconciliador pular (`connection-reconciler.service.ts`). Vale lembrar que a
 * premissa deste módulo inteiro é que o GoZap responde 200 para coisas que não
 * honra — foi assim que ele aceitou um webhook inalcançável.
 */
function readLiveState(data: GozapStatusOrConnectResponse): GozapLiveState {
  const inst = data.instance;
  const status = inst?.status;
  if (status === 'connected' || data.runtime?.logged_in === true) {
    return {
      state: 'open',
      phoneE164: gozapOwnerToE164(inst?.owner),
      profileName: inst?.profileName ?? null,
      profilePictureUrl: inst?.profilePicUrl ?? null,
    };
  }
  return {
    state:
      status && KNOWN_GOZAP_STATUS.has(status)
        ? mapConnectionState(status)
        : null,
    phoneE164: gozapOwnerToE164(inst?.owner),
    profileName: inst?.profileName ?? null,
    profilePictureUrl: inst?.profilePicUrl ?? null,
  };
}

/**
 * Extrai um resumo do erro HTTP sem nunca ecoar o corpo da resposta (pode
 * conter dados do tenant) NEM o objeto do erro inteiro. Exportada de
 * propósito: é o único formato que qualquer `logger.warn`/`logger.error`
 * desta classe pode receber para representar uma falha HTTP — nunca o
 * AxiosError bruto, cujo `err.config.headers` carrega o token PLAINTEXT da
 * instância (o serializer de erro padrão do pino percorre esse objeto
 * inteiro e escreveria o segredo em claro no log).
 */
/**
 * `https://user:senha@host:443/api/x?t=SEGREDO` → `https://host`. Usado para
 * relatar uma base de webhook mal configurada sem correr o risco de imprimir o
 * segredo que alguém possa ter colado dentro dela. Nunca lança: o valor
 * reportado pode nem ser uma URL.
 */
function safeOrigin(raw: string | null | undefined): string {
  if (!raw) return '<vazio>';
  try {
    return new URL(raw).origin;
  } catch {
    return '<não é uma URL>';
  }
}

export function describeHttpError(err: unknown): string {
  const e = err as { response?: { status?: number }; message?: string };
  if (e.response?.status) return `HTTP ${e.response.status}`;
  return e.message ?? 'erro desconhecido';
}

/**
 * F-A Task 7 — ciclo de vida da instância GoZap: criação (`POST
 * /instance/create`), QR (`POST /instance/connect`, via `GET
 * /instance/status` primeiro) e desligamento (`disconnect`/`remove`).
 *
 * Deliberadamente um SERVICE separado do `GozapCloudAdapter` (que só cobre
 * ENVIO) — o ciclo de vida da sessão não é uma capacidade que o adapter
 * declara (ver a nota no topo de `gozap-cloud.adapter.ts`); a UI decide
 * mostrar a seção GoZap pelo trait `sessionBased`, não pela capability.
 *
 * SEGREDO: `POST /instance/create` devolve um token que autentica TODAS as
 * chamadas de gerência/envio daquela instância. Ele é cifrado (AES-256-GCM,
 * `gozap-token-cipher`) ANTES de tocar o banco — o valor cru só existe em
 * memória, na variável local de cada método, pelo tempo de UMA (ou duas, na
 * criação) chamadas HTTP — e NUNCA é devolvido ao chamador: toda leitura
 * retorna a row com `gozapInstanceToken` (e `apiKey`) removidos, no mesmo
 * padrão do `apiKey` do Evolution (`be-whatsapp-003`).
 */
@Injectable()
export class GozapInstancesService {
  private readonly logger = new Logger(GozapInstancesService.name);
  private readonly http: AxiosInstance;

  /**
   * `POST /instance/connect` cria sessão no GoZap a cada chamada — igual ao
   * `/instance/connect` do Evolution (ver `qrCache` em
   * `evolution-api.adapter.ts`, mesma justificativa: chamar em todo poll da
   * UI vira uma tempestade de sessões concorrentes). Cacheado por
   * `channelId` para que `getConnectionInfo` só recrie sessão quando o cache
   * expira, não a cada poll.
   */
  private static readonly QR_CACHE_MS = 25_000;

  /** Janela do alarme de webhook mal configurado — ver `resolveWebhookUrl`. */
  private static readonly ALARM_EVERY_MS = 3_600_000;
  private lastWebhookUrlAlarmAt = 0;

  private readonly qrCache = new Map<
    string,
    { fetchedAt: number; qrBase64?: string; state: ConnectionState }
  >();

  constructor(
    private readonly config: ConfigService<Env>,
    private readonly repo: WhatsappInstancesRepository,
    private readonly audit: AuditService,
    private readonly providersRepo: WhatsappProvidersRepository,
    private readonly replay: ReconnectReplayService,
  ) {
    this.http = axios.create({
      baseURL: config.get('GOZAP_BASE_URL', { infer: true }) ?? '',
      headers: { 'Content-Type': 'application/json' },
      timeout: 30_000,
    });
  }

  /**
   * `POST /instance/create` (header `admintoken`) → cifra o token da
   * instância → grava a row → arma o webhook (best-effort: uma falha ao
   * armar não pode impedir a criação do canal — o operador ainda consegue
   * conectar via QR e reconfigurar o webhook depois).
   */
  async createChannel(input: {
    name: string;
    isDefault?: boolean;
  }): Promise<SafeGozapChannel> {
    const adminToken = this.config.get('GOZAP_ADMIN_TOKEN', { infer: true });
    if (!adminToken) throw new ProviderNotConfiguredError('GOZAP');
    const encryptionKey = this.encryptionKey();

    // Guard de duplicata — sem isto, um duplo-clique ou um retry do operador
    // provisiona DUAS instâncias no GoZap (cada POST /instance/create gera um
    // id novo, então o @unique de gozapInstanceId nunca pega essa colisão) e
    // deixa duas rows ativas sem jeito de saber qual é a "certa". Diferente de
    // createOrReactivateCloudChannel (TWILIO/ZERNIO/META): aqui NÃO existe
    // reativação de canal soft-deletado — remove() já chamou DELETE /instance
    // no GoZap, então a row antiga aponta pra uma instância que não existe
    // mais, e reativá-la seria pior que recusar e pedir um nome novo.
    const existing = await this.repo.findActiveGozapChannelByName(input.name);
    if (existing) {
      throw new DomainError({
        code: 'gozap.duplicate_name',
        message: `Já existe um canal GoZap ativo chamado "${input.name}".`,
        status: 400,
        detail: `channelId=${existing.id}`,
      });
    }

    let data: GozapCreateInstanceResponse;
    try {
      const res = await this.http.post<GozapCreateInstanceResponse>(
        '/instance/create',
        { name: input.name, connection_mode: 'companion' },
        { headers: { admintoken: adminToken } },
      );
      data = res.data;
    } catch (err) {
      throw new DomainError({
        code: 'gozap.creation_failed',
        message: `GoZap recusou a criação da instância "${input.name}": ${describeHttpError(err)}`,
        status: 502,
      });
    }

    // O token vem tanto no topo (`token`) quanto ecoado em `instance.token`
    // pela doc — aceita qualquer um dos dois por robustez.
    const plainToken = data.token ?? data.instance?.token;
    const instanceId = data.instance?.id;
    if (!plainToken || !instanceId) {
      throw new DomainError({
        code: 'gozap.creation_invalid_response',
        message:
          'GoZap aceitou a criação da instância mas não retornou token/id — canal NÃO foi gravado.',
        status: 502,
      });
    }

    const channel = await this.repo.createGozapChannel({
      name: input.name,
      gozapInstanceId: instanceId,
      gozapInstanceToken: encryptToken(plainToken, encryptionKey),
    });

    if (input.isDefault) {
      await this.repo.setDefault(channel.id);
    }

    await this.armWebhook(plainToken).catch((err) => {
      // NUNCA `{ err }` cru: o serializer de erro do pino percorre
      // `err.config.headers`, onde viaja o token PLAINTEXT (header `token`
      // da chamada que falhou) — logaria o segredo em claro. describeHttpError
      // extrai só o essencial (status/mensagem), nunca a request/response.
      this.logger.warn(
        { err: describeHttpError(err), channelId: channel.id },
        'gozap: falha ao armar o webhook na criação do canal (best-effort)',
      );
    });

    await this.audit.log('instance.create', 'WhatsappInstance', channel.id, {
      name: channel.name,
      provider: 'GOZAP',
      gozapInstanceId: channel.gozapInstanceId,
    });

    const finalRow = input.isDefault
      ? ((await this.repo.findById(channel.id)) ?? channel)
      : channel;
    return this.omitSecrets(finalRow);
  }

  /**
   * `GET /instance/status` primeiro — SEM efeito colateral, seguro para
   * polling. Só chama `POST /instance/connect` (que CRIA sessão no GoZap)
   * quando o status ainda não é `connected` — nunca em cima de uma instância
   * já pareada, para não recriar sessão a cada poll da UI. E mesmo quando
   * ainda não está pareada, um cache de `QR_CACHE_MS` evita recriar sessão a
   * CADA poll — só quando o cache expira.
   *
   * Se o `GET /instance/status` falhar, NÃO cai para `/instance/connect`:
   * sem saber o estado atual, chamar o endpoint que cria sessão seria às
   * cegas — devolve o que houver em cache (mesmo velho) ou `close`.
   *
   * Também re-arma o webhook a cada chamada (best-effort, idempotente — o
   * GoZap substitui a lista inteira a cada `POST /webhook`, ver
   * `armWebhook`). Autocura o caso em que o `armWebhook` da criação falhou
   * em silêncio e o canal nasceu sem receptor de ack.
   */
  async getConnectionInfo(
    channelId: string,
  ): Promise<{ state: ConnectionState; qrBase64?: string }> {
    const channel = await this.mustFindGozapChannel(channelId);
    if (!channel.gozapInstanceToken) {
      // Nunca foi possível provisionar/parear — nada a consultar no GoZap.
      return { state: 'close' };
    }
    const token = decryptToken(
      channel.gozapInstanceToken,
      this.encryptionKey(),
    );

    await this.armWebhook(token).catch((err) => {
      this.logger.warn(
        { err: describeHttpError(err), channelId },
        'gozap: falha ao re-armar o webhook durante o polling (best-effort)',
      );
    });

    let lastKnownStatus: string | undefined;
    try {
      const { data } = await this.http.get<GozapStatusOrConnectResponse>(
        '/instance/status',
        { headers: { token } },
      );
      lastKnownStatus = data.instance?.status;
      const live = readLiveState(data);
      await this.persistLiveState(channel, live);
      if (live.state === 'open') {
        this.qrCache.delete(channelId);
        return { state: 'open' };
      }
    } catch (err) {
      this.logger.warn(
        { err: describeHttpError(err), channelId },
        'gozap: falha ao consultar /instance/status',
      );
      return this.cachedOrClose(channelId);
    }

    const now = Date.now();
    const cached = this.qrCache.get(channelId);
    if (cached && now - cached.fetchedAt < GozapInstancesService.QR_CACHE_MS) {
      return { state: cached.state, qrBase64: cached.qrBase64 };
    }

    try {
      const { data } = await this.http.post<GozapStatusOrConnectResponse>(
        '/instance/connect',
        {},
        { headers: { token } },
      );
      const state = mapConnectionState(
        data.instance?.status ?? lastKnownStatus,
      );
      const qrBase64 = data.instance?.qrcode;
      this.qrCache.set(channelId, { fetchedAt: now, qrBase64, state });
      return { state, qrBase64 };
    } catch (err) {
      this.logger.warn(
        { err: describeHttpError(err), channelId },
        'gozap: falha ao obter QR (/instance/connect)',
      );
      return this.cachedOrClose(channelId);
    }
  }

  /** O que houver em cache (mesmo velho) para este canal, ou `close` se nunca houve nada. */
  private cachedOrClose(channelId: string): {
    state: ConnectionState;
    qrBase64?: string;
  } {
    const cached = this.qrCache.get(channelId);
    return cached
      ? { state: cached.state, qrBase64: cached.qrBase64 }
      : { state: 'close' };
  }

  /**
   * Reconcilia o banco com o estado AO VIVO da sessão GoZap. Chamado pelo poll
   * do QR e pelo `GozapConnectionReconcilerProcessor`.
   *
   * INCIDENTE DE PRODUÇÃO (2026-08-07) — por que isto existe:
   * `GOZAP` é `sessionBased: true` (`channel-provider.schema.ts`), e o roteador
   * (`whatsapp-instance-router.service.ts`, `isInstanceOnline`) exige uma linha
   * `WhatsappConnectionEvent(state='open')` para deixar QUALQUER mensagem sair.
   * Só que nada no orgamind jamais escrevia essa linha para GOZAP: o webhook do
   * GoZap manda o evento `connection` e `processConnectionEvent` só entende o
   * `connection.update` do Evolution; o `ConnectionReconcilerService` pula todo
   * canal sem `evolutionInstanceName`; e este service LIA o estado ao vivo mas
   * devolvia só na resposta HTTP, sem gravar nada. Resultado: o cliente pareou
   * o número, o diálogo mostrou "Conectado!", e o canal seguiu, para o resto do
   * sistema, permanentemente offline — no assistente de campanha ele aparecia
   * como "desconectada", com o rádio desabilitado, e qualquer envio pararia em
   * `WAITING_INSTANCE` em silêncio.
   *
   * Best-effort por contrato: uma falha de escrita NUNCA pode derrubar a
   * resposta de QR. Pior caso volta a ser o comportamento antigo.
   */
  private async persistLiveState(
    channel: Channel,
    live: GozapLiveState,
  ): Promise<void> {
    try {
      // Só estados DEFINITIVOS viram evento — mesmo critério do
      // ConnectionReconcilerService do Evolution. `connecting` é transitório (o
      // QR está na tela) e gravá-lo a cada poll de 3s viraria ruído.
      if (live.state === 'open' || live.state === 'close') {
        const last = await this.providersRepo.findLastEvent(channel.id);
        if ((last?.state ?? null) !== live.state) {
          await this.providersRepo.createEvent({
            instanceId: channel.id,
            state: live.state,
            reasonCode: null,
            occurredAt: new Date(),
          });
        }
      }

      // Sessão aberta = as mensagens paradas em WAITING_INSTANCE têm por onde
      // sair. Dirigido pelo ESTADO OBSERVADO, não pela transição de evento
      // acima: se o replay falhasse na única transição (timeout de pool no
      // meio de um disparo grande), o evento 'open' já estaria gravado e todo
      // tick seguinte veria "sem mudança" — as mensagens ficariam presas para
      // sempre. É idempotente (o `updateMany` guardado por
      // `status:'WAITING_INSTANCE'` faz o segundo chamador reivindicar 0) e
      // barato (índice `@@index([instanceId, status])` em Message).
      //
      // Sem `await`, com catch próprio: espelha `webhooks.controller.ts`, que
      // faz `void this.replayService.replayWaitingFor(...)` de propósito — o
      // replay enfileira UMA job por mensagem, em série, e segurar a resposta
      // do poll de QR nisso estoura o timeout de 15s do cliente justamente no
      // instante de backlog máximo (a primeira conexão do canal).
      if (live.state === 'open') {
        void this.replay.replayWaitingFor(channel.id).catch((err: unknown) => {
          this.logger.error(
            { err: describeHttpError(err), channelId: channel.id },
            'gozap: falha ao destravar mensagens em WAITING_INSTANCE após a conexão',
          );
        });
      }

      // `owner` ausente significa "não sei" (uma sessão fechando ainda pode não
      // reportá-lo) — preservar o que está gravado, nunca apagar.
      if (!live.phoneE164) return;
      const numberChanged = live.phoneE164 !== channel.phoneE164;
      const profileName = live.profileName ?? channel.profileName;
      const profilePictureUrl =
        live.profilePictureUrl ?? channel.profilePictureUrl;
      if (
        numberChanged ||
        profileName !== channel.profileName ||
        profilePictureUrl !== channel.profilePictureUrl
      ) {
        await this.repo.updateDeviceProfile(channel.id, {
          phoneE164: live.phoneE164,
          profileName,
          profilePictureUrl,
          // Número novo = (re)pareamento → reinicia a rampa de aquecimento. O
          // GoZap é não-oficial como o Evolution: mesmo risco de ban, mesma
          // rampa. Drift só de nome/foto NÃO reinicia (o número nunca se
          // formaria).
          ...(numberChanged ? { warmupStartedAt: new Date() } : {}),
        });
      }
    } catch (err) {
      this.logger.warn(
        { err: describeHttpError(err), channelId: channel.id },
        'gozap: falha ao persistir o estado ao vivo da sessão (best-effort)',
      );
    }
  }

  /**
   * Converge UM canal GOZAP contra o GoZap, sem efeito colateral de sessão.
   *
   * Diferente de `getConnectionInfo`, NUNCA chama `POST /instance/connect` (que
   * CRIA sessão no GoZap) — este caminho roda de 60 em 60s no worker e criar
   * sessão a cada tick seria uma tempestade. Re-arma o webhook (idempotente),
   * o que também autocura uma URL de webhook corrigida em env sem exigir que
   * alguém abra o diálogo de QR.
   *
   * Devolve o estado observado, ou `null` quando não deu para observar.
   */
  async reconcileConnection(
    channelId: string,
  ): Promise<ConnectionState | null> {
    const channel = await this.repo.findById(channelId);
    if (
      !channel ||
      channel.provider !== 'GOZAP' ||
      !channel.gozapInstanceToken
    ) {
      return null;
    }
    const token = decryptToken(
      channel.gozapInstanceToken,
      this.encryptionKey(),
    );

    await this.armWebhook(token).catch((err) => {
      this.logger.warn(
        { err: describeHttpError(err), channelId },
        'gozap: falha ao re-armar o webhook durante o reconcile (best-effort)',
      );
    });

    let live: GozapLiveState;
    try {
      const { data } = await this.http.get<GozapStatusOrConnectResponse>(
        '/instance/status',
        { headers: { token } },
      );
      live = readLiveState(data);
    } catch (err) {
      this.logger.warn(
        { err: describeHttpError(err), channelId },
        'gozap: falha ao consultar /instance/status no reconcile',
      );
      return null;
    }

    await this.persistLiveState(channel, live);
    return live.state;
  }

  /** `POST /instance/disconnect` — best-effort (log-and-continue no falha, como o logout do Evolution). */
  async disconnect(channelId: string): Promise<void> {
    const channel = await this.mustFindGozapChannel(channelId);
    if (channel.gozapInstanceToken) {
      const token = decryptToken(
        channel.gozapInstanceToken,
        this.encryptionKey(),
      );
      try {
        await this.http.post(
          '/instance/disconnect',
          {},
          { headers: { token } },
        );
      } catch (err) {
        this.logger.warn(
          { err: describeHttpError(err), channelId },
          'gozap: falha ao desconectar a instância (best-effort)',
        );
      }
    }
    // Sessão encerrada (ou tentativa feita) — o QR/estado cacheado não vale mais.
    this.qrCache.delete(channelId);
    // E o banco precisa saber AGORA. Sem esta linha o último evento continua
    // 'open' até o próximo tick do reconciliador (até 60s), e nesse intervalo o
    // roteador ainda entrega para uma sessão morta: o GoZap devolve
    // `gozap.not_connected`, que NÃO está na guarda de reparque do
    // send-message.processor (escopada a `evolution.not_connected`), então a
    // mensagem queima as tentativas e morre FAILED em vez de esperar.
    await this.providersRepo
      .createEvent({
        instanceId: channelId,
        state: 'close',
        reasonCode: null,
        occurredAt: new Date(),
      })
      .catch((err: unknown) => {
        this.logger.warn(
          { err: describeHttpError(err), channelId },
          'gozap: falha ao registrar o evento de desconexão (best-effort)',
        );
      });
    await this.audit.log('instance.disconnect', 'WhatsappInstance', channelId, {
      provider: 'GOZAP',
    });
  }

  /** `DELETE /instance` (best-effort) + soft-delete da row — mesmo padrão de WhatsappInstancesService.delete. */
  async remove(channelId: string): Promise<void> {
    const channel = await this.mustFindGozapChannel(channelId);
    if (channel.gozapInstanceToken) {
      const token = decryptToken(
        channel.gozapInstanceToken,
        this.encryptionKey(),
      );
      try {
        await this.http.delete('/instance', { headers: { token } });
      } catch (err) {
        this.logger.warn(
          { err: describeHttpError(err), channelId },
          'gozap: falha ao remover a instância no GoZap (best-effort); soft-delete segue',
        );
      }
    }
    this.qrCache.delete(channelId);
    await this.repo.softDelete(channelId);
    await this.audit.log('instance.delete', 'WhatsappInstance', channelId, {
      provider: 'GOZAP',
    });
  }

  /**
   * Substitui TODA a lista de webhooks da instância (o GoZap não faz
   * append). `url` carrega o segredo do webhook como query string
   * (`?t=<GOZAP_WEBHOOK_TOKEN>`) — é como o endpoint receptor (Task 6)
   * autentica a origem. `excludeMessages: ['wasSentByApi']` evita eco dos
   * próprios envios feitos pelo orgamind.
   */
  private async armWebhook(instanceToken: string): Promise<void> {
    const url = this.resolveWebhookUrl();
    if (!url) return;
    // Enquanto a compat da query estiver ligada, a URL leva `?t=` e nada muda.
    // Desligada, a URL vai LIMPA e a credencial passa a viajar no cabeçalho —
    // ver `resolveWebhookUrl` e o comentário do bloco abaixo.
    const credentialHeaders = this.webhookCredentialHeaders();
    // DUAS entradas, não uma. `excludeMessages: ['wasSentByApi']` existe para
    // não ecoar no inbox as mensagens que o próprio orgamind envia — mas ele
    // filtra a INSTÂNCIA INTEIRA, inclusive os recibos (`messages_update`) das
    // nossas mensagens, que são justamente os acks de entrega. Incidente
    // 2026-08-07: o registro do GoZap mostrava `wasSentByApi: "True"` na nossa
    // mensagem e nenhum recibo jamais chegou. O `POST /webhook` aceita uma
    // LISTA (doc: "aceita um objeto, um array ou { webhooks: [...] }"), então o
    // filtro fica só onde o eco importa.
    //
    // Precisa ser `{ webhooks: [...] }`. A doc do GoZap afirma que o endpoint
    // "aceita um objeto, um array ou `{ webhooks: [...] }`" — o ARRAY CRU é
    // recusado com `400 {"error":"invalid json body"}` (medido em produção
    // 2026-08-07). Só a forma envelopada passa.
    await this.http.post(
      '/webhook',
      {
        webhooks: [
          {
            url,
            enabled: true,
            events: ['messages'],
            excludeMessages: ['wasSentByApi'],
            ...credentialHeaders,
          },
          {
            url,
            enabled: true,
            events: ['messages_update', 'connection'],
            ...credentialHeaders,
          },
        ],
      },
      { headers: { token: instanceToken } },
    );
  }

  /**
   * A URL que o GoZap vai CHAMAR — precisa ser alcançável pela INTERNET.
   *
   * INCIDENTE (2026-08-07): isto era `${WEBHOOK_BASE_URL}/webhooks/gozap?t=…`,
   * e `WEBHOOK_BASE_URL` é interna POR PROJETO (`.env.prod.example`: "internal
   * Docker DNS; Evolution calls api directly"). Em produção virou
   * `http://api:3000/webhooks/gozap?t=…` — nome de serviço do compose. O
   * Evolution resolve isso porque mora no mesmo compose; o GoZap é SaaS de
   * terceiro e não. Pior: o GoZap ACEITA o registro com 200 (só falharia ao
   * ENTREGAR), então nada estourou e nada foi logado.
   *
   * Ordem: `PUBLIC_WEBHOOK_BASE_URL` (a var cujo contrato É ser pública) e,
   * como retaguarda, `WEBHOOK_BASE_URL` — mas SEMPRE atrás do guard. Se nada
   * resolver para um endereço público, NÃO registra: sobrescrever um webhook
   * correto por um inalcançável é estritamente pior do que não mexer.
   */
  private resolveWebhookUrl(): string | null {
    const base =
      this.config.get('PUBLIC_WEBHOOK_BASE_URL', { infer: true })?.trim() ||
      this.config.get('WEBHOOK_BASE_URL', { infer: true });
    if (!isExternallyReachableUrl(base)) {
      // `error`, não `warn`: isto é má configuração de deploy, não falha
      // transitória de rede — e foi justamente a ausência de qualquer linha
      // `level>=40` que fez o incidente passar 17h despercebido.
      //
      // Estrangulado a 1x/hora por processo: o reconciliador chama isto a cada
      // 60s por canal, e um alarme que se repete 1440 vezes por dia deixa de
      // ser alarme. O remédio para a cegueira não pode ser o ruído.
      const now = Date.now();
      if (
        now - this.lastWebhookUrlAlarmAt >=
        GozapInstancesService.ALARM_EVERY_MS
      ) {
        this.lastWebhookUrlAlarmAt = now;
        this.logger.error(
          // Só a ORIGEM. A env é documentada como "base", mas nada IMPEDE
          // alguém de colar a URL completa (que carrega `?t=<segredo>`) ou uma
          // URL com userinfo — e as duas reprovam no guard e cairiam aqui.
          { webhookBase: safeOrigin(base) },
          'gozap: a base do webhook NÃO é alcançável pela internet — webhook NÃO armado. ' +
            'Defina PUBLIC_WEBHOOK_BASE_URL com a URL pública da API (ex.: https://SEU-DOMINIO/api). ' +
            'Sem isso o canal pareia mas nunca recebe ack de entrega, mensagem recebida nem opt-out.',
        );
      }
      return null;
    }
    const webhookToken = this.config.get('GOZAP_WEBHOOK_TOKEN', {
      infer: true,
    });
    // A env é documentada como BASE (`https://dominio/api`), mas o que o painel
    // do GoZap exibe é a URL COMPLETA — e colá-la aqui é o engano natural.
    // Ingênuo, `base + '/webhooks/gozap?t='` produziria
    // `…/webhooks/gozap?t=TOK/webhooks/gozap?t=TOK`, e o `@Query('t')` do
    // receptor resolveria para lixo: TODA entrega voltaria 401. É a mesma
    // classe de erro de configuração que este guard existe para pegar, então
    // trata os dois: descarta query/fragment e não duplica o caminho quando ele
    // já termina no endpoint.
    const parsed = new URL(base!);
    const path = parsed.pathname.replace(/\/+$/, '');
    const root = path.endsWith(WEBHOOK_PATH)
      ? path.slice(0, -WEBHOOK_PATH.length)
      : path;
    const endpoint = `${parsed.origin}${root}${WEBHOOK_PATH}`;
    // ★ ACHADO C20 — SOMOS NÓS QUE PENDURAMOS O SEGREDO NA URL.
    //
    // Query string vai INTEIRA para o access log de todo proxy do caminho (74
    // linhas de produção em 52h com o token de 48 hex em texto claro). Mas
    // simplesmente parar de mandá-la seria pior: o receptor ainda aceita a
    // query, o painel do GoZap tem essa URL gravada, e uma URL sem credencial
    // nenhuma faria toda entrada voltar 401 — em silêncio.
    //
    // Então o interruptor é UM SÓ, e vale para os dois lados: enquanto
    // GOZAP_WEBHOOK_ALLOW_QUERY_TOKEN estiver ligado (o padrão), a URL sai como
    // sempre saiu. Desligado — o passo final da migração, dado quando o
    // cabeçalho já está funcionando —, a URL vai LIMPA, e é aí que este método
    // deixa de reintroduzir o segredo a cada re-pareamento de canal.
    if (!this.queryTokenAllowed()) return endpoint;
    return `${endpoint}?t=${webhookToken}`;
  }

  /**
   * `false` só quando o operador desligou explicitamente a compat da query.
   * MESMA comparação do receptor (`gozap-webhooks.controller.ts`): a
   * ConfigService devolve o booleano já validado pelo zod, e qualquer coisa
   * diferente de `false` mantém o comportamento antigo — um deploy que não
   * conhece a var não pode reescrever a URL do webhook por conta própria.
   */
  private queryTokenAllowed(): boolean {
    return (
      this.config.get('GOZAP_WEBHOOK_ALLOW_QUERY_TOKEN', { infer: true }) !==
      false
    );
  }

  /**
   * Cabeçalho de credencial da ENTRADA de webhook (o que o GoZap vai mandar
   * PARA nós), só no modo sem query. Nome espelhado de `TOKEN_HEADER` em
   * `modules/webhooks/gozap-webhooks.controller.ts` — não é importado de lá de
   * propósito, para não criar dependência de um controller de outro módulo no
   * meio do adaptador; `gozap-instances.service.spec.ts` amarra os dois nomes.
   *
   * O campo `headers` NÃO está documentado pelo GoZap (a doc deles já mentiu
   * antes: `dry_run` que envia, array cru recusado). Se ele for ignorado, a
   * entrada volta 401 e o alarme aparece; se o POST /webhook for recusado por
   * causa dele, o `catch` de quem chama registra a falha. Os dois desfechos são
   * ruidosos e acontecem SÓ depois que o operador desliga a compat — nunca no
   * caminho padrão de uma campanha rodando. Ver OPERATIONS.md.
   */
  private webhookCredentialHeaders():
    | { headers: Record<string, string> }
    | Record<string, never> {
    if (this.queryTokenAllowed()) return {};
    const token = this.config.get('GOZAP_WEBHOOK_TOKEN', { infer: true });
    if (!token) return {};
    return { headers: { 'X-Webhook-Token': token } };
  }

  private async mustFindGozapChannel(channelId: string): Promise<Channel> {
    const channel = await this.repo.findById(channelId);
    if (!channel || channel.provider !== 'GOZAP') {
      throw new InstanceNotFoundError(channelId);
    }
    return channel;
  }

  private omitSecrets(channel: Channel): SafeGozapChannel {
    const { apiKey: _apiKey, gozapInstanceToken: _token, ...safe } = channel;
    return safe;
  }

  private encryptionKey(): string {
    const key = this.config.get('GOZAP_TOKEN_ENCRYPTION_KEY', { infer: true });
    if (!key) {
      throw new DomainError({
        code: 'gozap.encryption_key_missing',
        message: 'GOZAP_TOKEN_ENCRYPTION_KEY não configurada neste ambiente',
        status: 500,
      });
    }
    return key;
  }
}
