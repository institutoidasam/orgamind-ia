import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../shared/redis/redis.module';
import {
  ZernioApiClient,
  ZernioHttpError,
  znum,
  zstr,
  type ZernioOffsetPage,
} from './zernio-api.client';
import {
  chunkRecipients,
  isChunkTooLargeError,
  shrinkChunk,
} from './zernio-broadcast-chunk.helper';
import type { ZernioVariableMapping } from './zernio-broadcast-variables';

/** O `limit` do `GET /{id}/recipients`. Máximo aceito pela API. */
const PAGE_SIZE = 100;

/**
 * Os status que o Zernio reporta POR DESTINATÁRIO. Qualquer outra coisa vira
 * `null` — um status novo do Zernio não pode derrubar a página inteira nem, pior,
 * ser confundido com um dos nossos.
 */
const RECIPIENT_STATUSES = new Set([
  'pending',
  'sent',
  'delivered',
  'read',
  'failed',
]);

export type ZernioRecipientStatusValue =
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed';

/**
 * Uma linha do `GET /v1/broadcasts/{id}/recipients`.
 *
 * ⚠️ ZW — LEIA ANTES DE CONFIAR NESTE ENDPOINT. Sondagem AO VIVO (13/07, conta
 * de produção). A resposta REAL, por destinatário, é EXATAMENTE esta:
 *
 * ```json
 * { "id": "a1b2c3d4e5f6a7b8c9d00008",
 *   "contactId": "a1b2c3d4e5f6a7b8c9d00006",
 *   "channelId": "a1b2c3d4e5f6a7b8c9d00007",
 *   "platformIdentifier": "5592995550101",
 *   "contactName": "+5592995550101",
 *   "status": "pending",
 *   "errorExplanation": null }
 * ```
 *
 * **NÃO existe `messageId` (o wamid). NÃO existem `sentAt`/`deliveredAt`/
 * `readAt`. NÃO existe `errorCode`.** E o `status` está MORTO: 30+ minutos depois
 * do disparo começar, os 50 destinatários amostrados continuavam TODOS `pending`
 * — enquanto os webhooks já mostravam entregas.
 *
 * Por isso este endpoint deixou de ser a fundação do status e virou um
 * RECONCILIADOR LENTO (ver `ZernioBroadcastPollService`). A fonte da verdade é o
 * WEBHOOK, que chega em tempo real e traz o wamid.
 *
 * O telefone (`platformIdentifier`) é a única coisa aqui em que dá para confiar —
 * e é a chave do casamento com a `Message` do orgamind.
 */
export type ZernioRecipientStatus = {
  /** E.164 com '+' — normalizado (a API manda sem o '+'). */
  phone: string;
  status: ZernioRecipientStatusValue | null;
  /**
   * O wamid. Na prática vem SEMPRE null: a API não o expõe aqui. Mantido só
   * porque é barato e, se o Zernio um dia passar a mandá-lo, o parser já o lê —
   * mas NADA no orgamind pode DEPENDER dele (o `providerMessageId` é carimbado pelo
   * WEBHOOK, que é quem realmente tem o wamid).
   */
  messageId: string | null;
  /** Idem: a API não manda código de erro aqui. Vem null na prática. */
  errorCode: string | null;
  /** Este, sim, vem: o texto do erro ("Message undeliverable"). */
  errorExplanation: string | null;
};

export type CreateBroadcastInput = {
  profileId: string;
  accountId: string;
  name: string;
  templateName: string;
  templateLanguage: string;
  /** Ver zernio-broadcast-variables.ts — só literais chegam aqui. */
  variableMapping: ZernioVariableMapping;
  /** `components` do template, pass-through (a doc é vaga; omitir é o padrão). */
  components?: unknown;
};

export type SendBroadcastResult = {
  status: string;
  sent: number;
  failed: number;
  recipientCount: number;
};

/** `+55...` / `55...` → `+55...`. O Zernio devolve dos dois jeitos. */
function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits ? `+${digits}` : raw;
}

/**
 * O cliente de ESCRITA dos broadcasts do Zernio — o caminho que faz a campanha do
 * orgamind APARECER NO PAINEL do cliente.
 *
 * Irmão do `ZernioAnalyticsClient` (que só LÊ, e cujo `zernio-broadcast-sync`
 * espelha o que o painel disparou). Os dois herdam do MESMO
 * {@link ZernioApiClient}, e isso não é elegância: é o balde. O rate limit do
 * Zernio é de **60 req/min POR CHAVE de API**, e a chave é UMA no deploy — o
 * envio, o polling e o sync bebem todos dela. Quem fala com o Zernio passa pelo
 * `get`/`post` daqui, e ambos esperam o slot antes de sair.
 *
 * ## O fluxo (4 chamadas, nesta ordem — a API é um statechart)
 *
 * ```
 * POST /broadcasts              → cria o rascunho, devolve o id
 * POST /{id}/recipients         → adiciona os telefones (EM BLOCOS — ver abaixo)
 * POST /{id}/send               → dispara
 * POST /{id}/cancel             → o KILL-SWITCH: aborta em voo
 * GET  /{id}/recipients         → o status POR DESTINATÁRIO (o polling)
 * ```
 *
 * ## Por que os destinatários vão em BLOCOS
 *
 * Não é (só) o limite anunciado de 100/request — que, aliás, não está no OpenAPI.
 * É que `phones[]` **auto-cria contatos no CRM do Zernio** e NENHUM endpoint de
 * broadcast aceita `Idempotency-Key`: uma requisição gigante que dá timeout e é
 * retentada pelo BullMQ tem comportamento INDEFINIDO. Bloco pequeno = retry
 * barato, estrago pequeno. E se o servidor recusar por tamanho, o
 * {@link addRecipients} LÊ o corpo do erro, encolhe e retenta — é o corpo do erro
 * que revela o limite real, e é a única fonte confiável dele que existe.
 */
@Injectable()
export class ZernioBroadcastClient extends ZernioApiClient {
  constructor(config: ConfigService, @Inject(REDIS_CLIENT) redis: Redis) {
    super(config, redis);
  }

  /**
   * Cria o RASCUNHO do disparo. Nada sai daqui — o `send` é que dispara.
   *
   * `profileId` e `accountId` são obrigatórios na API. Quem chama garante que
   * existem: sem eles a criação falha, e falhar aqui (antes de qualquer
   * destinatário) é a falha BARATA que queremos.
   */
  async createBroadcast(
    channelId: string,
    input: CreateBroadcastInput,
  ): Promise<string> {
    const data = await this.post<Record<string, unknown>>(
      [channelId],
      '/broadcasts',
      {
        profileId: input.profileId,
        accountId: input.accountId,
        platform: 'whatsapp',
        name: input.name,
        template: {
          name: input.templateName,
          language: input.templateLanguage,
          variableMapping: input.variableMapping,
          ...(input.components !== undefined
            ? { components: input.components }
            : {}),
        },
      },
    );

    const broadcast =
      typeof data?.broadcast === 'object' && data.broadcast !== null
        ? (data.broadcast as Record<string, unknown>)
        : {};
    const id = zstr(broadcast.id) ?? zstr(data?.id);
    if (!id) {
      // Sem id não há como adicionar destinatário, disparar, cancelar ou pollar.
      // Um disparo órfão no painel do cliente é ruim; um disparo órfão que a
      // gente acha que criou e não consegue cancelar é MUITO pior.
      throw new Error(
        `Zernio aceitou POST /broadcasts mas não retornou id: ${JSON.stringify(data ?? {}).slice(0, 200)}`,
      );
    }
    return id;
  }

  /**
   * Adiciona os destinatários, EM BLOCOS, com AUTO-BACKOFF por tamanho.
   *
   * O laço não é `for (chunk of chunks)` porque o tamanho do bloco pode MUDAR no
   * meio: quando o servidor recusa por tamanho, encolhemos e refazemos o corte a
   * partir de quem ainda não entrou. Por isso o cursor é sobre a LISTA, não sobre
   * uma fatia pré-calculada — refatiar é o ponto.
   *
   * Devolve o `chunkUsed` final: é o que o canal deve aprender para o próximo
   * disparo (ver `Channel.zernioBroadcastChunk`).
   */
  async addRecipients(
    channelId: string,
    broadcastId: string,
    phones: string[],
    chunkSize: number,
  ): Promise<{ added: number; skipped: number; chunkUsed: number }> {
    // Um `/recipients` com `phones: []` é um 400 de graça. Não gaste o balde.
    if (phones.length === 0) return { added: 0, skipped: 0, chunkUsed: chunkSize };

    let size = Math.max(1, Math.floor(chunkSize));
    let cursor = 0;
    let added = 0;
    let skipped = 0;

    while (cursor < phones.length) {
      const [batch] = chunkRecipients(phones.slice(cursor), size);
      try {
        const data = await this.post<Record<string, unknown>>(
          [channelId],
          `/broadcasts/${broadcastId}/recipients`,
          { phones: batch },
        );
        added += znum(data?.added);
        skipped += znum(data?.skipped);
        cursor += batch.length;
      } catch (err) {
        if (!(err instanceof ZernioHttpError)) throw err;
        if (!isChunkTooLargeError(err.status, err.body as never)) {
          // NÃO é "grande demais" — é um dado ruim (telefone inválido), uma chave
          // revogada, um broadcast inexistente. Encolher não conserta nenhum
          // deles: só gastaria o balde para reencontrar o mesmo erro.
          throw err;
        }
        const next = shrinkChunk(size, err.body as never);
        if (next === null) {
          // Já estávamos em 1 destinatário por requisição e ainda assim recusou.
          // Não há para onde encolher — isto não é mais um problema de tamanho.
          throw err;
        }
        this.logger.warn(
          `Zernio recusou um bloco de ${size} destinatários em ${broadcastId} ` +
            `(${err.status}) — encolhendo para ${next} e retentando. ` +
            `Corpo: ${JSON.stringify(err.body ?? {}).slice(0, 200)}`,
        );
        size = next;
        // cursor NÃO avança: o mesmo pedaço volta, agora menor.
      }
    }

    return { added, skipped, chunkUsed: size };
  }

  /** DISPARA. Daqui para a frente as mensagens são reais, cobradas e irreversíveis. */
  async sendBroadcast(
    channelId: string,
    broadcastId: string,
  ): Promise<SendBroadcastResult> {
    const data = await this.post<Record<string, unknown>>(
      [channelId],
      `/broadcasts/${broadcastId}/send`,
      {},
    );
    return {
      status: zstr(data?.status) ?? 'sending',
      sent: znum(data?.sent),
      failed: znum(data?.failed),
      recipientCount: znum(data?.recipientCount),
    };
  }

  /**
   * ★ O KILL-SWITCH. Aborta um disparo EM VOO.
   *
   * É o que transforma "o quality rating despencou" / "131031 conta bloqueada" /
   * "132015 template pausado" numa perda de dezenas de mensagens em vez de
   * milhares.
   *
   * Devolve `false` (em vez de explodir) quando o Zernio recusa o cancelamento —
   * o caso normal é o disparo JÁ ter terminado. O kill-switch percorre N disparos
   * em best-effort, e um que já acabou não pode impedir o cancelamento dos que
   * ainda estão vivos.
   */
  async cancelBroadcast(
    channelId: string,
    broadcastId: string,
  ): Promise<boolean> {
    try {
      await this.post([channelId], `/broadcasts/${broadcastId}/cancel`, {});
      return true;
    } catch (err) {
      if (err instanceof ZernioHttpError) {
        this.logger.warn(
          `Zernio recusou o cancelamento do disparo ${broadcastId} (${err.status}) — ` +
            `provavelmente já terminou. Seguindo com os outros.`,
        );
        return false;
      }
      throw err;
    }
  }

  /**
   * O status POR DESTINATÁRIO — a matéria-prima do RECONCILIADOR (não a fonte da
   * verdade; ver o aviso em {@link ZernioRecipientStatus}).
   *
   * A doc descreve `message.sent` como *"sent FROM THE INBOX"* e não promete os
   * eventos `message.*` para broadcast — foi por isso que o desenho original
   * apostou tudo neste endpoint. **A sondagem ao vivo desmentiu os dois lados**:
   * o webhook DISPARA para broadcast (com o wamid, em tempo real) e este endpoint
   * NÃO devolve wamid, nem timestamps, nem errorCode — e o `status` dele fica
   * congelado em `pending`.
   *
   * O que ele dá de aproveitável: `platformIdentifier` (telefone), `status` e
   * `errorExplanation`. É com isso, e só com isso, que o reconciliador trabalha.
   *
   * ⚠️ Cada página COME um slot do balde de 60 req/min — o MESMO do envio. Quem
   * chama tem de ceder a vez ao envio (ver `zernioSendHasPriority`).
   */
  async listRecipients(
    channelId: string,
    broadcastId: string,
    skip: number,
  ): Promise<ZernioOffsetPage<ZernioRecipientStatus>> {
    const data = await this.get<Record<string, unknown>>(
      [channelId],
      `/broadcasts/${broadcastId}/recipients`,
      { limit: PAGE_SIZE, skip },
    );

    const raw = Array.isArray(data?.recipients)
      ? data.recipients
      : Array.isArray(data?.data)
        ? data.data
        : [];

    const items: ZernioRecipientStatus[] = [];
    for (const entry of raw) {
      const item = this.parseRecipient(entry);
      if (item) items.push(item);
    }

    const p =
      typeof data?.pagination === 'object' && data.pagination !== null
        ? (data.pagination as Record<string, unknown>)
        : {};
    // Sem bloco `pagination` => ACABOU. Um default otimista faria o polling
    // repetir a mesma página para sempre, queimando o balde do envio.
    return {
      items,
      hasMore: p.hasMore === true,
      total: typeof p.total === 'number' ? p.total : null,
    };
  }

  private parseRecipient(raw: unknown): ZernioRecipientStatus | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;

    // ★ ZW — O TELEFONE VEM EM `platformIdentifier`.
    //
    // Este era um BUG TOTAL, e silencioso: o parser procurava `phone` /
    // `phoneNumber` / `to` — campos que a API NÃO manda — e, não achando nenhum,
    // DESCARTAVA a linha inteira ("destinatário sem telefone — pulando"). Ou
    // seja: o polling não reconciliava NINGUÉM, nunca, e o warn passava batido.
    // Os fallbacks abaixo ficam por robustez, mas o campo real é o primeiro.
    const rawPhone =
      zstr(r.platformIdentifier) ??
      zstr(r.phone) ??
      zstr(r.phoneNumber) ??
      zstr(r.to);
    if (!rawPhone) {
      this.logger.warn(
        `destinatário de broadcast sem telefone — pulando: ${JSON.stringify(raw).slice(0, 200)}`,
      );
      return null;
    }

    const rawStatus = (zstr(r.status) ?? '').toLowerCase();
    const status = RECIPIENT_STATUSES.has(rawStatus)
      ? (rawStatus as ZernioRecipientStatusValue)
      : null;

    // A API não manda errorCode aqui (só `errorExplanation`) — mas se um dia
    // mandar, o orgamind casa códigos da Meta por STRING ('131026') em todos os
    // mappers. Normaliza number|string → string; ausente vira null.
    const rawCode = r.errorCode;
    const errorCode =
      rawCode != null && rawCode !== '' ? String(rawCode) : null;

    return {
      phone: toE164(rawPhone),
      status,
      messageId: zstr(r.messageId) ?? zstr(r.platformMessageId),
      errorCode,
      errorExplanation: zstr(r.errorExplanation) ?? zstr(r.errorMessage),
    };
  }
}
