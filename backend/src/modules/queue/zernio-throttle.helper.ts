import type Redis from 'ioredis';
import { parseEnvNumber } from './env-number.helper';

/**
 * ZA4 — throttle de envio do ZERNIO: no máximo 1 mensagem por segundo POR CANAL.
 *
 * Por que existe
 * --------------
 * O rate limit do Zernio é de **60 req/min POR CHAVE de API** (medido ao vivo:
 * `x-ratelimit-limit: 60`) — ou seja, **1 req/s é o teto real da conta**. E o
 * balde é COMPARTILHADO: o `zernio-inbox-sync` (a cada 10 min), o
 * `zernio-tier-sync` (24h) e o painel do cliente bebem do MESMO balde que o
 * envio. Um lote sem espaçamento vira uma sequência de 429 — que o mapper
 * classifica como retentável, então a fila entra em retry-storm e o disparo
 * arrasta por horas sem que ninguém entenda o porquê.
 *
 * Como o BullMQ não faz rate-limit POR CHAVE no OSS (o `limiter` do worker é
 * GLOBAL, e `groups` é do BullMQ Pro), o espaçamento é feito com um slot em
 * Redis: `SET key 1 PX 1000 NX` — só o primeiro envio do canal na janela vence;
 * os demais são ADIADOS (`moveToDelayed`) pelo tempo que falta. O gate roda
 * ANTES do claim atômico, então um job adiado não desperdiça claim nem slot de
 * tier.
 *
 * Convivência com o sync (a parte que não pode ser esquecida)
 * -----------------------------------------------------------
 * Este arquivo governa o ENVIO **e a LEITURA**. A nota original dizia que os
 * jobs de sync eram "1 requisição por tick" e que por isso podiam ficar de fora
 * do balde. **Era falso, e custou um incidente:** o `zernio-inbox-sync` faz
 * 1 requisição POR CONVERSA (~100 na conta real) e rodava sem espaçamento
 * nenhum — a cada 10 min pelo tick, e também no botão "Sincronizar inbox".
 * Em produção: 429 do Zernio → exceção → **HTTP 500 na cara do operador**,
 * nenhuma conversa importada, e o balde do ENVIO roubado no meio do caminho.
 *
 * A regra agora é literal: **quem fala com o Zernio passa por este balde.**
 * - O ENVIO adia o job quando perde o slot (`acquireZernioSendSlot` +
 *   `moveToDelayed`): tem um job na mão, adiar é de graça.
 * - A LEITURA espera o slot (`waitForZernioSlot`): está no meio de um laço de
 *   conversas e não tem job para adiar.
 * A chave Redis é a MESMA nos dois. Um balde paralelo para a leitura somaria
 * 2 req/s e furaria os 60 req/min exatamente como antes.
 *
 * Limite residual conhecido: o balde do Zernio é por CHAVE de API (uma só no
 * deploy), e esta chave aqui é por CANAL — com N canais ZERNIO ativos, N req/s.
 * A saída documentada no dossiê é uma chave dedicada por worker
 * (`POST /v1/api-keys`); enquanto ela não existe, o teto real se segura com
 * 1 canal ZERNIO ativo por deploy.
 *
 * Redis fora → fail-open (envia/lê). Estourar o balde devolve 429, que é
 * retentável — e a leitura agora faz backoff lendo `Retry-After`. Travar TODO o
 * envio porque o Redis piscou seria um estrago maior.
 */
export const ZERNIO_SEND_MIN_INTERVAL_MS = parseEnvNumber(
  process.env.ZERNIO_SEND_MIN_INTERVAL_MS,
  1000,
  'ZERNIO_SEND_MIN_INTERVAL_MS',
);

/** Jitter máximo somado ao adiamento — evita manada acordando no mesmo ms. */
const RETRY_JITTER_MAX_MS = 250;

export const zernioThrottleKey = (channelId: string) =>
  `zernio:send:throttle:${channelId}`;

export type ZernioSendSlot =
  { acquired: true } | { acquired: false; retryDelayMs: number };

export async function acquireZernioSendSlot(
  redis: Redis,
  channelId: string,
): Promise<ZernioSendSlot> {
  const key = zernioThrottleKey(channelId);
  try {
    const ok = await redis.set(
      key,
      '1',
      'PX',
      ZERNIO_SEND_MIN_INTERVAL_MS,
      'NX',
    );
    if (ok === 'OK') return { acquired: true };

    // Alguém enviou por este canal há menos de ZERNIO_SEND_MIN_INTERVAL_MS.
    // Espera exatamente o que falta da janela (+ jitter): adiar mais do que
    // isso desperdiça vazão; adiar menos faz o job voltar e ser recusado.
    const ttl = await redis.pttl(key);
    const wait = ttl > 0 ? ttl : ZERNIO_SEND_MIN_INTERVAL_MS;
    return {
      acquired: false,
      retryDelayMs: wait + Math.floor(Math.random() * RETRY_JITTER_MAX_MS),
    };
  } catch {
    // Fail-open — ver o cabeçalho.
    return { acquired: true };
  }
}

/** Injetável só para o teste conseguir um relógio virtual. */
export type Sleeper = (ms: number) => Promise<void>;

const realSleep: Sleeper = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Espera ATÉ conseguir o slot do canal — a porta de entrada da LEITURA no balde
 * do envio (a mesma chave; ver o cabeçalho).
 *
 * Por que esperar, e não adiar: o sync está no meio de um laço de ~100 conversas.
 * Não há job para `moveToDelayed`, e desistir da conversa por causa de 800ms de
 * espera seria trocar um 429 por um buraco no histórico.
 *
 * `maxWaitMs` é o cinto de segurança: se o balde estiver disputado a ponto de a
 * leitura não passar nunca (campanha grande em curso), ela desiste da ESPERA e
 * segue — quem chama trata isso cedendo a vez (ver `ZernioInboxSyncService`).
 * Sem esse teto, um job de sync ficaria pendurado segurando o worker.
 */
export async function waitForZernioSlot(
  redis: Redis,
  channelId: string,
  opts: { sleep?: Sleeper; maxWaitMs?: number } = {},
): Promise<void> {
  const sleep = opts.sleep ?? realSleep;
  const maxWaitMs = opts.maxWaitMs ?? 60_000;
  let waited = 0;

  for (;;) {
    const slot = await acquireZernioSendSlot(redis, channelId);
    if (slot.acquired) return;
    if (waited + slot.retryDelayMs > maxWaitMs) return;
    await sleep(slot.retryDelayMs);
    waited += slot.retryDelayMs;
  }
}
