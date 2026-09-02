import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

const DEFAULT_BASE_URL = 'https://zernio.com/api/v1';

/** Uma conta WhatsApp do Zernio (`GET /accounts`), normalizada. */
export type ZernioAccount = {
  /** O `_id` (ObjectId) — é ELE que vai em `Channel.zernioAccountId`. */
  id: string;
  displayName: string | null;
  /** `metadata.displayPhoneNumber` normalizado para E.164 puro. */
  phoneE164: string | null;
  /**
   * ZC — o `profileId._id` (o Profile agrupa contas no Zernio). Vem como objeto
   * (`{_id, name}`) no `GET /accounts`. É campo OBRIGATÓRIO do
   * `POST /broadcasts`: sem guardá-lo, a campanha nativa do Zernio não sai.
   */
  profileId?: string;
  wabaId?: string;
  qualityRating?: string;
  messagingLimitTier?: string;
  nameStatus?: string;
};

/**
 * ZB — a saúde do número na Meta, como `GET /whatsapp/number-info?accountId=`
 * a devolve (endpoint CONFIRMADO ao vivo em 12/07: HTTP 200).
 *
 * É um superconjunto do que `GET /accounts` traz em `metadata`: além de tier,
 * qualidade e nameStatus, expõe `health_status.can_send_message`
 * (`AVAILABLE` | `LIMITED` | `BLOCKED`) e o texto da Meta explicando o porquê.
 * É esse par que revela o estado REAL do número do cliente hoje: **LIMITED**
 * ("o limite sobe quando o nome de exibição for aprovado"), ou seja, o envio
 * não está bloqueado — está CAPADO, e o teto nominal do tier não vale.
 */
export type ZernioNumberHealth = {
  accountId: string;
  /** Formatado pela Meta ("+55 92 3155-0101") — é para EXIBIR, não para casar. */
  displayPhoneNumber?: string;
  messagingLimitTier?: string;
  qualityRating?: string;
  nameStatus?: string;
  /** Ex.: `BIZ_COMMERCE_VIOLATION_OTHER`. Só vem quando nameStatus = DECLINED. */
  nameRejectionReason?: string;
  /** `AVAILABLE` | `LIMITED` | `BLOCKED` — o veredito da Meta sobre ENVIAR. */
  canSendMessage?: string;
  /** O `additional_info` da entidade PHONE_NUMBER: o motivo, em texto da Meta. */
  canSendMessageReason?: string;
};

/**
 * Resultado de {@link ZernioAccountsService.lookup}. `unavailable` é um estado
 * de PRIMEIRA CLASSE, não um erro: o Zernio fora do ar não pode impedir o
 * operador de configurar um canal (indisponibilidade deles ≠ indisponibilidade
 * nossa) — quem chama degrada e marca o canal para revalidação.
 */
export type ZernioAccountLookup =
  | { status: 'found'; account: ZernioAccount }
  | { status: 'not_found'; accounts: ZernioAccount[] }
  | { status: 'unavailable'; reason: string };

/**
 * `metadata.displayPhoneNumber` vem FORMATADO pela Meta ("+55 92 99999-8888"),
 * mas `Channel.phoneE164` guarda E.164 puro — é a chave por onde o webhook do
 * Twilio casa o canal e por onde o inbox exibe o número. Guardar o valor
 * formatado criaria um canal cujo número não casa com nada.
 */
export function zernioPhoneToE164(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

/**
 * ZA2 — `metadata.messagingLimitTier` → `Channel.dailySendLimit`.
 *
 * A escada da Meta conta **usuários ÚNICOS em 24h ROLANTES**, não mensagens por
 * dia civil (o `TIER_2K` do número do cliente = 2.000 pessoas distintas / 24h
 * móveis). `TIER_UNLIMITED` vira 1.000.000 — sentinela prática, como no Twilio.
 *
 * Tier desconhecido/ausente → `null`, e o tier-sync NÃO MEXE no canal. Chutar um
 * teto é o pior dos dois mundos: alto demais queima o número (rejeições da Meta
 * → quality rating despenca), baixo demais trava a campanha. O valor configurado
 * no canal prevalece até a Meta dizer outra coisa.
 */
const TIER_LIMITS: Record<string, number> = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1000,
  TIER_2K: 2000,
  TIER_10K: 10000,
  TIER_100K: 100000,
  TIER_UNLIMITED: 1000000,
};

export function parseZernioTier(raw: string | undefined | null): number | null {
  if (!raw) return null;
  return TIER_LIMITS[raw.trim().toUpperCase()] ?? null;
}

/** String não-vazia ou `undefined` — o payload da Meta usa `null` à vontade. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * O `profileId` vem POPULADO no `GET /accounts` — um objeto `{_id, name}`, não
 * uma string (verificado ao vivo). Aceitamos a string crua também: a API pode
 * deixar de popular a referência sem aviso, e um `[object Object]` gravado no
 * canal só apareceria como erro lá na frente, no `POST /broadcasts`.
 */
function parseProfileId(v: unknown): string | undefined {
  if (typeof v === 'string') return v.length > 0 ? v : undefined;
  if (typeof v === 'object' && v !== null) {
    return str((v as Record<string, unknown>)._id);
  }
  return undefined;
}

/**
 * O motivo do capamento vive na entidade **PHONE_NUMBER** do `health_status`.
 * As outras (WABA, BUSINESS, APP) aparecem AVAILABLE e carregam só ruído de
 * SIP/calling — pegar a primeira entidade da lista mostraria o texto errado.
 */
function phoneEntityReason(entities: unknown): string | undefined {
  if (!Array.isArray(entities)) return undefined;
  for (const raw of entities) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (e.entity_type !== 'PHONE_NUMBER') continue;
    const info = e.additional_info;
    if (Array.isArray(info)) {
      const first = info.find((i) => typeof i === 'string' && i.length > 0);
      if (typeof first === 'string') return first;
    }
    return str(info);
  }
  return undefined;
}

/**
 * Cliente de `GET /accounts` do Zernio — a lista de contas WhatsApp conectadas
 * na conta do cliente (o `_id` de cada uma é o `zernioAccountId` do canal).
 *
 * Existe por causa de um incidente de produção: o canal era criado com um
 * `zernioAccountId` digitado à mão, e um id errado produzia uma falha
 * SILENCIOSA — os webhooks chegavam, autenticavam, não resolviam canal nenhum e
 * eram descartados com um `logger.warn`. Um disparo inteiro (~100 mensagens) foi
 * perdido sem nenhum sinal na interface. Validar o id contra esta lista na
 * CRIAÇÃO do canal é a barreira que torna aquele estado inalcançável.
 */
@Injectable()
export class ZernioAccountsService {
  private readonly logger = new Logger(ZernioAccountsService.name);
  private readonly http: AxiosInstance;
  /** False em deploy sem credencial Zernio — o lookup devolve `unavailable`. */
  readonly configured: boolean;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ZERNIO_API_KEY')?.trim() ?? '';
    const baseURL =
      config.get<string>('ZERNIO_BASE_URL')?.trim() || DEFAULT_BASE_URL;
    this.configured = apiKey.length > 0;
    this.http = axios.create({
      baseURL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      // Curto de propósito: isto roda DENTRO de um POST /whatsapp/channels que
      // o operador está esperando. Se o Zernio demorar, degradamos rápido em vez
      // de segurar a request.
      timeout: 10_000,
    });
  }

  /** Lista as contas. Lança se a API falhar — use {@link lookup} para degradar. */
  async listAccounts(): Promise<ZernioAccount[]> {
    const { data } = await this.http.get<{ accounts?: unknown[] }>('/accounts');
    const items = Array.isArray(data?.accounts) ? data.accounts : [];
    const accounts: ZernioAccount[] = [];
    for (const raw of items) {
      const account = this.parseAccount(raw);
      if (account) accounts.push(account);
    }
    return accounts;
  }

  /**
   * Resolve um `accountId` contra a lista real de contas do Zernio.
   * NUNCA lança: uma falha de rede/API vira `unavailable` para que a criação do
   * canal degrade (com aviso) em vez de ficar refém do uptime do Zernio.
   */
  async lookup(accountId: string): Promise<ZernioAccountLookup> {
    if (!this.configured) {
      return { status: 'unavailable', reason: 'ZERNIO_API_KEY não configurada' };
    }
    let accounts: ZernioAccount[];
    try {
      accounts = await this.listAccounts();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `não foi possível listar as contas do Zernio (${reason}) — validação degradada`,
      );
      return { status: 'unavailable', reason };
    }
    const wanted = accountId.trim();
    const account = accounts.find((a) => a.id === wanted);
    return account
      ? { status: 'found', account }
      : { status: 'not_found', accounts };
  }

  /**
   * ZB — a saúde do número na Meta (`GET /whatsapp/number-info?accountId=`).
   *
   * **Nunca lança e nunca é caminho crítico.** Saúde é DIAGNÓSTICO: o Zernio
   * fora do ar — ou este endpoint sumindo numa versão futura da API — não pode
   * derrubar a página Canais. Falhou → `null`, e quem chama cai no fallback do
   * `GET /accounts` (que já traz tier/qualidade/nameStatus em `metadata`, só
   * sem o `can_send_message`).
   *
   * Custo no balde: 1 requisição POR CONTA (diferente do `/accounts`, que
   * devolve todas de uma vez). O balde é de 60 req/min POR CHAVE e é o MESMO do
   * envio — por isso isto roda sob demanda (o operador abre a tela), nunca em
   * polling.
   */
  async fetchNumberInfo(accountId: string): Promise<ZernioNumberHealth | null> {
    if (!this.configured) return null;
    try {
      const { data } = await this.http.get<Record<string, unknown>>(
        '/whatsapp/number-info',
        { params: { accountId } },
      );
      return this.parseNumberInfo(accountId, data);
    } catch (err) {
      this.logger.warn(
        `number-info indisponível para a conta ${accountId} (${
          err instanceof Error ? err.message : String(err)
        }) — a saúde cai no fallback de GET /accounts`,
      );
      return null;
    }
  }

  private parseNumberInfo(
    accountId: string,
    data: Record<string, unknown> | null | undefined,
  ): ZernioNumberHealth {
    const top = data ?? {};
    const phone =
      typeof top.phone === 'object' && top.phone !== null
        ? (top.phone as Record<string, unknown>)
        : {};
    const health =
      typeof phone.health_status === 'object' && phone.health_status !== null
        ? (phone.health_status as Record<string, unknown>)
        : {};

    return {
      accountId,
      displayPhoneNumber: str(phone.display_phone_number),
      // A Meta expõe o tier em dois campos com o mesmo valor; o longo é o que
      // sempre veio preenchido na sondagem, o curto fica como fallback.
      messagingLimitTier:
        str(phone.whatsapp_business_manager_messaging_limit) ??
        str(phone.messaging_limit_tier),
      qualityRating: str(phone.quality_rating),
      nameStatus: str(phone.name_status),
      // Vem no TOPO do payload (fora de `phone`) e vem `null` quando a Meta não
      // expõe o código — `str()` transforma o null em undefined, para que o card
      // não mostre a string "null" como motivo.
      nameRejectionReason: str(top.nameRejectionReason),
      canSendMessage: str(health.can_send_message),
      canSendMessageReason: phoneEntityReason(health.entities),
    };
  }

  private parseAccount(raw: unknown): ZernioAccount | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    // A doc/API usa `_id` (Mongo); aceitamos `id` como fallback defensivo.
    const id =
      (typeof r._id === 'string' && r._id) || (typeof r.id === 'string' && r.id);
    if (!id) {
      this.logger.warn(
        `pulando conta Zernio sem _id: ${JSON.stringify(raw).slice(0, 200)}`,
      );
      return null;
    }
    const metadata =
      typeof r.metadata === 'object' && r.metadata !== null
        ? (r.metadata as Record<string, unknown>)
        : {};
    return {
      id,
      displayName: str(r.displayName) ?? null,
      phoneE164: zernioPhoneToE164(str(metadata.displayPhoneNumber)),
      profileId: parseProfileId(r.profileId),
      wabaId: str(metadata.wabaId),
      qualityRating: str(metadata.qualityRating),
      messagingLimitTier: str(metadata.messagingLimitTier),
      nameStatus: str(metadata.nameStatus),
    };
  }
}
