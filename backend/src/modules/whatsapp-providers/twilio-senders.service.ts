import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import type { Env } from '../../shared/config/env.schema';

/** Um sender WhatsApp da Senders API v2, normalizado. */
export type TwilioSender = {
  /** Sender SID (`XE` + 32 hex). */
  sid: string;
  /** Cru da Twilio, ex. `whatsapp:+5592111111111`. */
  senderId: string;
  /** E.164 sem o prefixo `whatsapp:` — casa com Channel.phoneE164. */
  phoneE164: string;
  /** Cru, ex. `"1K Customers/24hr"` | `"Unavailable"`. Ver parseMessagingLimit. */
  messagingLimit?: string;
  /** `"HIGH" | "MEDIUM" | "LOW" | "UNKNOWN"` (cru da Twilio). */
  qualityRating?: string;
};

/**
 * T8 — mapa do messaging_limit (tier da Meta) para o dailySendLimit do canal:
 *   "250" → 250, "1K" → 1000, "10K" → 10000, "100K" → 100000,
 *   "UNLIMITED" → 1000000 (sentinela prática para "ilimitado").
 * "Unavailable"/desconhecido → null: o tier-sync NÃO mexe no canal (portfólio
 * não verificado ainda não expõe o limite — manter o valor configurado).
 * O valor real vem como "10K Customers/24hr"; só o primeiro token importa.
 */
export function parseMessagingLimit(raw: string | undefined): number | null {
  if (!raw) return null;
  const token = raw.trim().split(/\s+/)[0]?.toUpperCase();
  switch (token) {
    case '250':
      return 250;
    case '1K':
      return 1000;
    case '10K':
      return 10000;
    case '100K':
      return 100000;
    case 'UNLIMITED':
      return 1000000;
    default:
      return null;
  }
}

/**
 * Cliente da Twilio Senders API v2 (host `messaging.twilio.com`, JSON) —
 * mesma credencial Basic `AccountSid:AuthToken` dos demais clientes Twilio.
 * Usado pelo job diário `twilio-tier-sync` para ler o `messaging_limit`
 * (tier da Meta) e a `quality_rating` de cada sender WhatsApp.
 */
@Injectable()
export class TwilioSendersService {
  private readonly logger = new Logger(TwilioSendersService.name);
  private readonly http: AxiosInstance;
  /** False em deploy sem o grupo de credenciais Twilio — o job deve no-op. */
  readonly configured: boolean;

  constructor(config: ConfigService<Env>) {
    const accountSid = config.get('TWILIO_ACCOUNT_SID', { infer: true }) ?? '';
    const authToken = config.get('TWILIO_AUTH_TOKEN', { infer: true }) ?? '';
    this.configured = accountSid.length > 0 && authToken.length > 0;
    // Override só para testes/dev (fake server); produção fala com o host real.
    const baseURL =
      config.get('TWILIO_SENDERS_BASE_URL', { infer: true })?.trim() ||
      'https://messaging.twilio.com';
    this.http = axios.create({
      baseURL,
      auth: { username: accountSid, password: authToken },
      timeout: 15_000,
    });
  }

  /**
   * Lista todos os senders WhatsApp da conta —
   * `GET /v2/Channels/Senders?Channel=whatsapp`, seguindo `meta.next_page_url`
   * até esgotar. Itens malformados são logados e pulados (um shape ruim nunca
   * aborta o sync inteiro) — mesmo contrato do TwilioContentService.
   */
  async listSenders(): Promise<TwilioSender[]> {
    const senders: TwilioSender[] = [];
    // Cap duro de páginas: um cursor quebrado nunca pode virar loop infinito.
    const MAX_PAGES = 20;
    let url: string | null = '/v2/Channels/Senders?Channel=whatsapp&PageSize=100';
    for (let page = 0; page < MAX_PAGES && url; page++) {
      const { data } = await this.http.get<{
        senders?: unknown[];
        meta?: { next_page_url?: string | null };
      }>(url);
      const items = Array.isArray(data?.senders) ? data.senders : [];
      for (const raw of items) {
        const sender = this.parseSender(raw);
        if (sender) senders.push(sender);
      }
      const next = data?.meta?.next_page_url;
      url = typeof next === 'string' && next.length > 0 ? next : null;
      if (url && page === MAX_PAGES - 1) {
        this.logger.warn(
          `listSenders atingiu o cap de ${MAX_PAGES} páginas; páginas restantes ignoradas`,
        );
      }
    }
    return senders;
  }

  private parseSender(raw: unknown): TwilioSender | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const sid = typeof r.sid === 'string' && r.sid.length > 0 ? r.sid : null;
    const senderId =
      typeof r.sender_id === 'string' && r.sender_id.length > 0
        ? r.sender_id
        : null;
    if (!sid || !senderId) {
      this.logger.warn(
        `Pulando sender malformado da Senders API: ${JSON.stringify(raw)}`,
      );
      return null;
    }
    const props =
      typeof r.properties === 'object' && r.properties !== null
        ? (r.properties as Record<string, unknown>)
        : {};
    return {
      sid,
      senderId,
      phoneE164: senderId.replace(/^whatsapp:/i, ''),
      messagingLimit:
        typeof props.messaging_limit === 'string'
          ? props.messaging_limit
          : undefined,
      qualityRating:
        typeof props.quality_rating === 'string'
          ? props.quality_rating
          : undefined,
    };
  }
}
