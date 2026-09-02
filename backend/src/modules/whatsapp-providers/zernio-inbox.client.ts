import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../shared/redis/redis.module';
import { ZernioApiClient } from './zernio-api.client';

/** Máximo aceito pela API (`limit` é capado em 100 nos dois endpoints). */
const PAGE_SIZE = 100;

// O 429 tipado mora no cliente-base (é a mesma regra para todo endpoint do
// Zernio). Reexportado aqui porque o sync do inbox já o importava daqui.
export { ZernioRateLimitError } from './zernio-api.client';

/** Uma conversa do inbox do Zernio (`GET /inbox/conversations`), normalizada. */
export type ZernioConversation = {
  id: string;
  accountId: string;
  /** 'whatsapp' | 'instagram' | ... — o sync só olha whatsapp. */
  platform: string;
  /** Telefone SEM `+` no WhatsApp ("559285550102"). */
  participantId: string;
  participantName: string | null;
  participantPicture: string | null;
  lastMessage: string | null;
  updatedTime: string | null;
  unreadCount: number | null;
};

/** Uma mensagem de uma conversa (`GET /inbox/conversations/{id}/messages`). */
export type ZernioInboxMessage = {
  /**
   * O **wamid** — nesta API REST o `id` da mensagem JÁ É o id da plataforma
   * ("wamid.HBgM…"). Cuidado: no WEBHOOK é diferente (lá `id` é o ObjectId do
   * Mongo e o wamid vive em `platformMessageId`). Os dois caminhos precisam
   * gravar a MESMA chave em `Message.providerMessageId`, senão o backfill
   * duplica tudo que o webhook já trouxe.
   */
  id: string;
  direction: 'incoming' | 'outgoing';
  message: string | null;
  senderName: string | null;
  senderPhoneNumber: string | null;
  createdAt: string;
  attachments: ZernioAttachment[];
};

export type ZernioAttachment = {
  type: string;
  url: string | null;
  filename: string | null;
};

/** Uma página de um endpoint paginado por CURSOR. */
export type ZernioPage<T> = {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Cliente do INBOX do Zernio (conversas + mensagens).
 *
 * Separado do {@link ZernioCloudAdapter} de propósito: o adapter implementa a
 * porta de ENVIO (`MessageProvider`), e o inbox é LEITURA de histórico — a porta
 * não tem (nem deveria ter) um método para isso.
 *
 * O HTTP (balde compartilhado + backoff no 429) mora no {@link ZernioApiClient}:
 * é a MESMA regra para todo endpoint do Zernio, e duplicá-la por cliente era um
 * convite a uma segunda implementação divergente.
 *
 * Duas armadilhas da API do Zernio, ambas descobertas na marra:
 *
 * 1. `/inbox/*` pagina por **cursor** (`pagination.nextCursor`), enquanto
 *    `/contacts` e `/broadcasts` paginam por **offset** (`limit`/`skip`). Passar
 *    `skip` aqui é silenciosamente ignorado — a mesma primeira página volta para
 *    sempre.
 * 2. `GET /inbox/conversations/{id}/messages` **exige `accountId` na query** e
 *    responde 400 sem ele (OpenAPI 3.1, seção /inbox). Sem esse parâmetro o
 *    endpoint parece não existir.
 */
@Injectable()
export class ZernioInboxClient extends ZernioApiClient {
  constructor(
    config: ConfigService,
    @Inject(REDIS_CLIENT) redis: Redis,
  ) {
    super(config, redis);
  }

  /** Uma página de conversas da conta. Lança em falha de rede/API. */
  async listConversations(
    channelId: string,
    accountId: string,
    cursor?: string,
  ): Promise<ZernioPage<ZernioConversation>> {
    const data = await this.get<Record<string, unknown>>(
      [channelId],
      '/inbox/conversations',
      { accountId, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
    );
    // A doc (e a API ao vivo) devolve `data`; `conversations` já foi observado.
    const raw = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.conversations)
        ? data.conversations
        : [];
    const items: ZernioConversation[] = [];
    for (const r of raw) {
      const conv = this.parseConversation(r);
      if (conv) items.push(conv);
    }
    return { items, ...this.parsePagination(data) };
  }

  /**
   * Uma página de mensagens de uma conversa, em ordem CRONOLÓGICA (`asc`).
   * `accountId` é obrigatório — ver a nota de classe.
   */
  async listMessages(
    channelId: string,
    conversationId: string,
    accountId: string,
    cursor?: string,
  ): Promise<ZernioPage<ZernioInboxMessage>> {
    const data = await this.get<Record<string, unknown>>(
      [channelId],
      `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        accountId,
        limit: PAGE_SIZE,
        sortOrder: 'asc',
        ...(cursor ? { cursor } : {}),
      },
    );
    const raw = Array.isArray(data?.messages) ? data.messages : [];
    const items: ZernioInboxMessage[] = [];
    for (const r of raw) {
      const msg = this.parseMessage(r);
      if (msg) items.push(msg);
    }
    return { items, ...this.parsePagination(data) };
  }

  /**
   * Sem bloco `pagination` => acabou. O default TEM de ser "não há mais": um
   * default otimista com `nextCursor` nulo faria o laço repetir a mesma página
   * para sempre.
   */
  private parsePagination(data: Record<string, unknown> | undefined): {
    hasMore: boolean;
    nextCursor: string | null;
  } {
    const p =
      typeof data?.pagination === 'object' && data.pagination !== null
        ? (data.pagination as Record<string, unknown>)
        : {};
    const nextCursor = str(p.nextCursor);
    // Só continua com AS DUAS condições: hasMore e um cursor de fato.
    return { hasMore: p.hasMore === true && !!nextCursor, nextCursor };
  }

  private parseConversation(raw: unknown): ZernioConversation | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const id = str(r.id);
    const accountId = str(r.accountId);
    const participantId = str(r.participantId);
    if (!id || !accountId || !participantId) {
      this.logger.warn(
        `conversa do Zernio sem id/accountId/participantId — pulando: ${JSON.stringify(raw).slice(0, 200)}`,
      );
      return null;
    }
    return {
      id,
      accountId,
      platform: str(r.platform) ?? '',
      participantId,
      participantName: str(r.participantName),
      participantPicture: str(r.participantPicture),
      lastMessage: str(r.lastMessage),
      updatedTime: str(r.updatedTime),
      unreadCount: typeof r.unreadCount === 'number' ? r.unreadCount : null,
    };
  }

  private parseMessage(raw: unknown): ZernioInboxMessage | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const id = str(r.id);
    // Sem wamid não há chave de dedupe — importar seria garantir duplicata na
    // próxima rodada. Melhor pular a mensagem.
    if (!id) {
      this.logger.warn(
        `mensagem do Zernio sem id (wamid) — pulando: ${JSON.stringify(raw).slice(0, 200)}`,
      );
      return null;
    }
    const attachments: ZernioAttachment[] = Array.isArray(r.attachments)
      ? r.attachments.flatMap((a) => {
          if (typeof a !== 'object' || a === null) return [];
          const at = a as Record<string, unknown>;
          return [
            {
              type: str(at.type) ?? '',
              url: str(at.url),
              filename: str(at.filename),
            },
          ];
        })
      : [];
    return {
      id,
      direction: r.direction === 'outgoing' ? 'outgoing' : 'incoming',
      message: str(r.message),
      senderName: str(r.senderName),
      senderPhoneNumber: str(r.senderPhoneNumber),
      createdAt: str(r.createdAt) ?? new Date().toISOString(),
      attachments,
    };
  }
}
