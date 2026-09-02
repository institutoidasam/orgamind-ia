import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../shared/redis/redis.module';
import {
  ZernioApiClient,
  znum,
  zstr,
  type ZernioOffsetPage,
} from './zernio-api.client';

/** Máximo aceito pela API. */
const PAGE_SIZE = 100;

/**
 * Um disparo do Zernio (`GET /broadcasts`), normalizado.
 *
 * Os contadores NÃO são um funil: são uma PARTIÇÃO dos destinatários pelo status
 * ATUAL de cada um (ao vivo: 120 = 2 sent + 10 delivered + 71 read + 37 failed).
 * Quem já foi LIDO saiu de `deliveredCount`. Ver `ZernioBroadcast` no schema.
 */
export type ZernioBroadcastItem = {
  id: string;
  /** A conta WhatsApp que disparou — é por ela que casamos com o canal. */
  accountId: string;
  accountName: string | null;
  /** 'whatsapp' | 'instagram' | … — o orgamind só espelha whatsapp. */
  platform: string;
  name: string;
  /** draft | scheduled | sending | completed | failed | cancelled (cru). */
  status: string;
  messagePreview: string | null;
  /** Extraído do preview quando ele é "Template: <nome>". */
  templateName: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
  recipientCount: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  failedCount: number;
  skippedCount: number;
};

// A paginação por OFFSET subiu para a base (`zernio-api.client.ts`): ela é a
// forma de TODOS os endpoints de broadcast, não deste cliente só. Reexportada
// para não quebrar quem já importava daqui.
export type { ZernioOffsetPage } from './zernio-api.client';

/** Um dia do `timeseries` do `GET /analytics/inbox/volume`. */
export type ZernioVolumeDay = {
  date: string;
  sent: number;
  received: number;
  read: number;
  failed: number;
};

export type ZernioInboxVolume = {
  summary: {
    sent: number;
    received: number;
    read: number;
    failed: number;
    uniqueConversations: number;
  };
  timeseries: ZernioVolumeDay[];
};

/**
 * O preview vem como "Template: bem_vindo_mg" quando o disparo é de template, e
 * como um trecho do texto quando não é. É a ÚNICA pista do template na listagem
 * (`GET /broadcasts` não devolve o objeto `template`).
 */
export function parseTemplateName(preview: string | null): string | null {
  if (!preview) return null;
  const m = /^\s*Template:\s*(\S+)\s*$/i.exec(preview);
  return m ? m[1] : null;
}

/**
 * Cliente de LEITURA do ZD: disparos + volume de mensagens do Zernio.
 *
 * ## O que é o `/analytics` do Zernio, de verdade (sondado ao vivo em 12/07)
 *
 * `GET /analytics` **não é analytics de WhatsApp**. É analytics de POSTS de rede
 * social (o Zernio é, antes de tudo, um agendador de posts): devolve
 * `{overview:{totalPosts:0,…}, posts:[], accounts:[…]}`. Para esta conta ele
 * responde 200 com **zero posts** — e sempre responderá, porque o orgamind não
 * publica post nenhum. Espelhar isso seria espelhar vazio.
 *
 * O que serve é a família **`/analytics/inbox/*`**, que o dossiê não tinha
 * mapeado: `GET /analytics/inbox/volume?accountId=&fromDate=&toDate=` devolve
 * `summary{sent,received,read,failed,uniqueConversations}`, um `timeseries`
 * diário e um `byPlatform`. Ao vivo, na conta do cliente: 121 enviadas, 23
 * recebidas, 72 lidas desde 01/06. É ISSO que o cliente pediu.
 *
 * Dois avisos que a sondagem revelou e que o consumidor precisa saber:
 * 1. **Não tem `delivered`.** O funil de entrega por disparo vem do
 *    `/broadcasts`; este endpoint é VOLUME.
 * 2. **O `failed` daqui mente por omissão**: contou 0 no mesmo período em que um
 *    broadcast reportou 37 falhas — destinatário rejeitado nunca vira "mensagem"
 *    no inbox do Zernio. Para falha, a fonte é o broadcast.
 * 3. O filtro `?source=` (human|broadcast|api|…) **não serve para dizer a
 *    origem**: `source=broadcast` devolve ZERO no mesmo período em que 121
 *    mensagens saíram de broadcasts. Só `source=contact` (o inbound) tem dado.
 *    A origem orgamind × painel sai do `ZernioBroadcast.campaignId`, não daqui.
 */
@Injectable()
export class ZernioAnalyticsClient extends ZernioApiClient {
  constructor(config: ConfigService, @Inject(REDIS_CLIENT) redis: Redis) {
    super(config, redis);
  }

  /**
   * Uma página de disparos. **Paginação por OFFSET** (`limit`/`skip`) — o
   * `/broadcasts` NÃO é por cursor como o `/inbox/conversations`. Mandar
   * `cursor` aqui é silenciosamente ignorado: a mesma primeira página voltaria
   * para sempre.
   *
   * A listagem é GLOBAL (não aceita `accountId`), então `channelIds` recebe
   * TODOS os canais ZERNIO ativos: uma requisição bebe do balde de todos eles.
   */
  async listBroadcasts(
    channelIds: string[],
    skip: number,
  ): Promise<ZernioOffsetPage<ZernioBroadcastItem>> {
    const data = await this.get<Record<string, unknown>>(
      channelIds,
      '/broadcasts',
      { limit: PAGE_SIZE, skip },
    );

    const raw = Array.isArray(data?.broadcasts) ? data.broadcasts : [];
    const items: ZernioBroadcastItem[] = [];
    for (const entry of raw) {
      const item = this.parseBroadcast(entry);
      if (item) items.push(item);
    }

    const p =
      typeof data?.pagination === 'object' && data.pagination !== null
        ? (data.pagination as Record<string, unknown>)
        : {};
    // Sem bloco `pagination` => ACABOU. Um default otimista faria o laço do sync
    // repetir a mesma página para sempre.
    return {
      items,
      hasMore: p.hasMore === true,
      total: typeof p.total === 'number' ? p.total : null,
    };
  }

  /**
   * O volume de mensagens de UMA conta no período. `fromDate` é OBRIGATÓRIO na
   * API (400 sem ele); `toDate` default = hoje.
   */
  async getInboxVolume(
    channelId: string,
    accountId: string,
    fromDate: string,
    toDate?: string,
  ): Promise<ZernioInboxVolume> {
    const data = await this.get<Record<string, unknown>>(
      [channelId],
      '/analytics/inbox/volume',
      { accountId, fromDate, ...(toDate ? { toDate } : {}) },
    );

    const s =
      typeof data?.summary === 'object' && data.summary !== null
        ? (data.summary as Record<string, unknown>)
        : {};
    const rawSeries = Array.isArray(data?.timeseries) ? data.timeseries : [];

    return {
      summary: {
        sent: znum(s.sent),
        received: znum(s.received),
        read: znum(s.read),
        failed: znum(s.failed),
        uniqueConversations: znum(s.uniqueConversations),
      },
      timeseries: rawSeries.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const d = entry as Record<string, unknown>;
        const date = zstr(d.date);
        if (!date) return [];
        return [
          {
            date,
            sent: znum(d.sent),
            received: znum(d.received),
            read: znum(d.read),
            failed: znum(d.failed),
          },
        ];
      }),
    };
  }

  private parseBroadcast(raw: unknown): ZernioBroadcastItem | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;

    const id = zstr(r.id);
    const accountId = zstr(r.accountId);
    // Sem `id` não há chave de upsert; sem `accountId` não há como achar o canal.
    // Um disparo torto é UM disparo perdido — não a página inteira.
    if (!id || !accountId) {
      this.logger.warn(
        `broadcast do Zernio sem id/accountId — pulando: ${JSON.stringify(raw).slice(0, 200)}`,
      );
      return null;
    }

    const messagePreview = zstr(r.messagePreview);
    return {
      id,
      accountId,
      accountName: zstr(r.accountName),
      platform: zstr(r.platform) ?? '',
      name: zstr(r.name) ?? '(sem nome)',
      status: zstr(r.status) ?? 'unknown',
      messagePreview,
      templateName: parseTemplateName(messagePreview),
      scheduledAt: zstr(r.scheduledAt),
      startedAt: zstr(r.startedAt),
      completedAt: zstr(r.completedAt),
      createdAt: zstr(r.createdAt),
      recipientCount: znum(r.recipientCount),
      sentCount: znum(r.sentCount),
      deliveredCount: znum(r.deliveredCount),
      readCount: znum(r.readCount),
      failedCount: znum(r.failedCount),
      skippedCount: znum(r.skippedCount),
    };
  }
}
