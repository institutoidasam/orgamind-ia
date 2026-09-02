import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, isAxiosError } from 'axios';
import type Redis from 'ioredis';
import { waitForZernioSlot } from '../queue/zernio-throttle.helper';

export const ZERNIO_DEFAULT_BASE_URL = 'https://zernio.com/api/v1';

/**
 * Uma página de um endpoint paginado por OFFSET (`limit`/`skip`).
 *
 * Mora aqui, na base, porque é a forma de paginação de TODOS os endpoints de
 * broadcast (`/broadcasts` e `/broadcasts/{id}/recipients`) — não de um cliente
 * só. ⚠️ O `/inbox/conversations` é por CURSOR: um paginador genérico ingênuo lê
 * a primeira página para sempre.
 */
export type ZernioOffsetPage<T> = {
  items: T[];
  hasMore: boolean;
  /** Total do servidor, quando ele o informa. */
  total: number | null;
};

/** Quantas vezes engolir um 429 antes de desistir da requisição. */
const MAX_RATE_LIMIT_RETRIES = 5;
/** Base do backoff exponencial quando o Zernio não diz quanto esperar. */
const BACKOFF_BASE_MS = 1_000;
/** Teto de UMA espera. Sem ele, um `Retry-After: 3600` pendura o worker. */
const BACKOFF_MAX_MS = 60_000;

/**
 * 429 que não cedeu nem depois de {@link MAX_RATE_LIMIT_RETRIES} esperas.
 *
 * Existe para ser TIPADO: quem chama (o sync) conta o item como falha e segue
 * com os outros. Antes, um 429 subia como `AxiosError` cru até o controller e
 * virava **HTTP 500 na cara do operador** — com zero itens importados e nenhuma
 * pista do que aconteceu.
 */
export class ZernioRateLimitError extends Error {
  constructor(readonly attempts: number) {
    super(
      `Zernio devolveu 429 mesmo após ${attempts} esperas — o balde de 60 req/min ` +
        `está saturado (envio em curso?). O item foi pulado; o próximo tick retoma.`,
    );
    this.name = 'ZernioRateLimitError';
  }
}

/**
 * Um erro HTTP do Zernio, com o STATUS e o CORPO preservados.
 *
 * Existe porque o auto-backoff do `/recipients` precisa LER a recusa para decidir
 * o que fazer com ela: um `400 "Maximum 100 recipients per request"` significa
 * "encolha o bloco e retente" (e o número real do limite está ali, na única fonte
 * confiável que existe sobre ele); um `400 "Invalid phone number"` significa "o
 * dado está errado" — retentar menor só gastaria o balde de 60 req/min duas vezes
 * para reencontrar o mesmo telefone ruim. Um `AxiosError` cru não deixa essa
 * distinção ser feita sem que cada chamador reimplemente o parsing.
 */
export class ZernioHttpError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly body: unknown,
    readonly method: string,
    readonly url: string,
  ) {
    super(
      `Zernio ${method.toUpperCase()} ${url} falhou com ${status ?? 'erro de rede'}: ` +
        `${JSON.stringify(body ?? {}).slice(0, 300)}`,
    );
    this.name = 'ZernioHttpError';
  }
}

/**
 * A porta ÚNICA de LEITURA da API do Zernio.
 *
 * A regra do projeto é literal: **quem fala com o Zernio passa pelo balde**
 * (`zernio-throttle.helper.ts`). O balde é de 60 req/min POR CHAVE de API e é
 * COMPARTILHADO com o ENVIO — um sync sem espaçamento vira 429, o mapper
 * classifica como retentável, e o disparo arrasta por horas. Já aconteceu em
 * produção. Esta classe existe para que essa regra não dependa de cada cliente
 * novo lembrar dela: quem herda daqui só consegue falar com o Zernio por
 * {@link get}, e o `get` espera o slot.
 *
 * `channelIds` (plural, e não `channelId`) porque nem todo endpoint do Zernio é
 * por conta. `/inbox/*` é por conta → um canal. `/broadcasts` é **global** (não
 * aceita `accountId`; só `profileId`/`status`/`platform`) → aquela ÚNICA
 * requisição bebe do balde de TODOS os canais, e por isso paga um slot em cada
 * um. Cobrar só o primeiro canal roubaria vazão do envio do segundo sem pagar.
 */
export abstract class ZernioApiClient {
  protected readonly logger = new Logger(this.constructor.name);
  protected readonly http: AxiosInstance;
  /** False em deploy sem credencial Zernio — o sync vira no-op. */
  readonly configured: boolean;

  constructor(
    config: ConfigService,
    private readonly redis: Redis,
    timeoutMs = 30_000,
  ) {
    const apiKey = config.get<string>('ZERNIO_API_KEY')?.trim() ?? '';
    const baseURL =
      config.get<string>('ZERNIO_BASE_URL')?.trim() || ZERNIO_DEFAULT_BASE_URL;
    this.configured = apiKey.length > 0;
    this.http = axios.create({
      baseURL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      // Generoso: isto roda num job de backfill, não numa request do operador.
      timeout: timeoutMs,
    });
  }

  /** `protected` só para o teste trocar o relógio por um virtual. */
  protected async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** idem — o teste compara `X-RateLimit-Reset` com o SEU relógio. */
  protected now(): number {
    return Date.now();
  }

  /**
   * TODA chamada ao Zernio passa por aqui. Duas guardas, nesta ordem:
   *
   * 1. **Balde compartilhado** (`waitForZernioSlot`): espera o slot de 1 req/s
   *    de CADA canal citado — o MESMO que o envio usa. É o que impede o sync de
   *    disparar 100 requisições num piscar e furar os 60 req/min do Zernio.
   * 2. **Backoff no 429**: se ainda assim vier 429 (o painel do cliente também
   *    bebe deste balde, e nós não o controlamos), espera o que o PROVEDOR
   *    mandar (`Retry-After` → `X-RateLimit-Reset` → exponencial) e retenta.
   *
   * Só o 429 é retentado. 401/403 (chave revogada, add-on cancelado) sobem na
   * hora: retentar não conserta e ainda queima o balde.
   */
  protected async get<T>(
    channelIds: string[],
    url: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      for (const channelId of channelIds) {
        await waitForZernioSlot(this.redis, channelId, {
          sleep: (ms) => this.delay(ms),
        });
      }
      try {
        const { data } = await this.http.get<T>(url, { params });
        return data;
      } catch (err) {
        if (!isAxiosError(err) || err.response?.status !== 429) throw err;
        if (attempt >= MAX_RATE_LIMIT_RETRIES) {
          throw new ZernioRateLimitError(attempt);
        }
        const wait = this.rateLimitWaitMs(err.response.headers, attempt);
        this.logger.warn(
          `429 do Zernio em ${url} — esperando ${wait}ms e retentando ` +
            `(${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`,
        );
        await this.delay(wait);
      }
    }
  }

  /**
   * A porta de ESCRITA. Mesmo balde, MESMA regra — e uma diferença que é a coisa
   * mais importante deste arquivo:
   *
   * **SÓ o 429 é retentado.** Nunca o timeout, nunca o 5xx.
   *
   * Nenhum endpoint de broadcast do Zernio aceita `Idempotency-Key`. Um 429
   * significa que a requisição foi RECUSADA na porta — ela não rodou, e repetir é
   * seguro. Um TIMEOUT (ou um 502) significa que não sabemos: o `POST /send` pode
   * ter disparado 200 mensagens de campanha eleitoral, cobradas e entregues, e o
   * cliente HTTP simplesmente não ouviu o "ok". Repetir isso é o envio duplicado
   * que a Meta lê como sinal de spam — e este número já teve display name
   * reprovado. Diante da dúvida, o erro SOBE (tipado, com status e corpo) e quem
   * chama decide; adivinhar aqui seria decidir errado em silêncio.
   */
  protected async post<T>(
    channelIds: string[],
    url: string,
    body: unknown,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      for (const channelId of channelIds) {
        await waitForZernioSlot(this.redis, channelId, {
          sleep: (ms) => this.delay(ms),
        });
      }
      try {
        const { data } = await this.http.post<T>(url, body);
        return data;
      } catch (err) {
        if (!isAxiosError(err)) throw err;
        const status = err.response?.status;
        if (status !== 429) {
          // Tipado, com corpo — é o que o auto-backoff do /recipients lê.
          throw new ZernioHttpError(status, err.response?.data, 'post', url);
        }
        if (attempt >= MAX_RATE_LIMIT_RETRIES) {
          throw new ZernioRateLimitError(attempt);
        }
        const wait = this.rateLimitWaitMs(err.response?.headers, attempt);
        this.logger.warn(
          `429 do Zernio em POST ${url} — esperando ${wait}ms e retentando ` +
            `(${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`,
        );
        await this.delay(wait);
      }
    }
  }

  /**
   * Quanto esperar depois de um 429. O Zernio manda `Retry-After` (segundos) e
   * `X-RateLimit-Reset` (unix ts) em TODA resposta — obedecer ao provedor é
   * sempre melhor do que adivinhar. Sem eles, exponencial com teto.
   */
  private rateLimitWaitMs(headers: unknown, attempt: number): number {
    const h = (headers ?? {}) as Record<string, unknown>;
    const read = (name: string): number | null => {
      const v = h[name] ?? h[name.toLowerCase()];
      const n = Number(
        typeof v === 'string' || typeof v === 'number' ? v : NaN,
      );
      return Number.isFinite(n) ? n : null;
    };

    const retryAfter = read('retry-after'); // segundos
    if (retryAfter !== null && retryAfter > 0) {
      return Math.min(retryAfter * 1000, BACKOFF_MAX_MS);
    }

    const reset = read('x-ratelimit-reset'); // unix ts (segundos)
    if (reset !== null && reset > 0) {
      const ms = reset * 1000 - this.now();
      if (ms > 0) return Math.min(ms, BACKOFF_MAX_MS);
    }

    return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
  }
}

/** Lê uma string não-vazia, ou null. */
export function zstr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Lê um inteiro do Zernio; ausente/torto = 0 (contador, nunca null). */
export function znum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
