/**
 * O TAMANHO DO BLOCO DE DESTINATÁRIOS — e por que ele NÃO está cravado no código.
 *
 * ⚠️ Escopo (desde 13/07): este bloco fatia REQUISIÇÕES do addRecipients dentro
 * de UM broadcast — ele NÃO fatia mais o disparo em N broadcasts (quem dita o
 * tamanho do disparo é o teto do tier, no dispatchBatch).
 *
 * O `POST /v1/broadcasts/{id}/recipients` do Zernio aceita `{phones[]}`. Quantos?
 *
 *   | limite                        | valor  | fonte                              | confiança |
 *   |-------------------------------|--------|------------------------------------|-----------|
 *   | destinatários por REQUISIÇÃO  | 100    | zernio.com/whatsapp (marketing)    | fraca     |
 *   | destinatários por BROADCAST   | nenhum | doc completa + OpenAPI (13/07); ≥1.015 medido num disparo real do painel | boa |
 *   | OpenAPI 1.0.4                 | nada   | sem `maxItems` no schema           | —         |
 *
 * A spec do Zernio **sabe** declarar limite (`maxItems: 1000` em `/contacts/bulk`)
 * e **não declarou** aqui. O silêncio não é descuido: ou não há limite, ou ele é
 * imposto no servidor e não no schema. Nós não sabemos — e não vamos descobrir
 * chutando contra a conta de PRODUÇÃO de um cliente real.
 *
 * A saída é dupla:
 *
 *  1. **Fatiar por padrão** ({@link ZERNIO_RECIPIENTS_CHUNK_DEFAULT}, conservador).
 *     O motivo não é estético: `phones[]` **auto-cria contatos no CRM do Zernio**
 *     e NENHUM endpoint de broadcast aceita `Idempotency-Key`. Uma requisição
 *     gigante que dá timeout + o retry do BullMQ = comportamento INDEFINIDO
 *     (contato duplicado? destinatário duplicado? mensagem dobrada?). Blocos
 *     pequenos tornam o retry barato e o estrago pequeno.
 *
 *  2. **Auto-backoff** ({@link isChunkTooLargeError} + {@link shrinkChunk}): se o
 *     servidor recusar o bloco por TAMANHO, LEIA O CORPO DO ERRO — é ele que
 *     revela o número real — encolha e retente. Se o limite real for MAIOR que o
 *     nosso default, o único custo é ter gasto algumas requisições a mais.
 *
 * Tudo aqui é PURO de propósito: é a parte que dá para provar sem falar com o
 * Zernio, e é justamente a que precisa estar certa ANTES do primeiro disparo.
 */

/**
 * Teto DURO por requisição. O site do Zernio anuncia "up to 100 recipients per
 * request" — é a única afirmação numérica que existe sobre o assunto, e não a
 * ultrapassamos nem se alguém configurar o canal com 5.000.
 */
export const ZERNIO_RECIPIENTS_CHUNK_MAX = 100;

/**
 * Default conservador (metade do teto anunciado): sobrevive a um limite real
 * MENOR do que o anunciado sem precisar de nenhuma ida ao servidor para
 * descobrir isso.
 */
export const ZERNIO_RECIPIENTS_CHUNK_DEFAULT = 50;

/** O tamanho REAL a usar, dado o que o canal configurou (`Channel.zernioBroadcastChunk`). */
export function effectiveChunkSize(
  configured: number | null | undefined,
): number {
  if (
    typeof configured !== 'number' ||
    !Number.isFinite(configured) ||
    configured <= 0
  ) {
    return ZERNIO_RECIPIENTS_CHUNK_DEFAULT;
  }
  return Math.min(Math.floor(configured), ZERNIO_RECIPIENTS_CHUNK_MAX);
}

/**
 * Fatia a lista em blocos de `size`. `size <= 0` cai em 1 — um passo zero faria
 * o laço de fatiamento nunca avançar (worker girando para sempre, segurando o
 * balde de 60 req/min do Zernio).
 */
export function chunkRecipients<T>(items: T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) {
    out.push(items.slice(i, i + step));
  }
  return out;
}

/** O corpo de erro do Zernio, só na parte que interessa aqui. */
export type ZernioErrorBodyLike =
  | { error?: unknown; message?: unknown }
  | undefined
  | null;

/** Junta as strings que o corpo do erro possa carregar, em minúsculas. */
function errorText(body: ZernioErrorBodyLike): string {
  if (!body || typeof body !== 'object') return '';
  const parts: string[] = [];
  for (const v of [body.error, body.message]) {
    if (typeof v === 'string') parts.push(v);
  }
  return parts.join(' ').toLowerCase();
}

/**
 * Palavras que, num 400, significam "o BLOCO é grande demais" — e não "os DADOS
 * estão errados". A distinção é o ponto inteiro: encolher o bloco não conserta
 * um telefone inválido, só gasta o balde de 60 req/min duas vezes (e o retry
 * reencontraria o mesmo telefone ruim na metade que o contém).
 */
const TOO_LARGE_HINTS = [
  'maximum',
  'max ',
  'too many',
  'too large',
  'exceed',
  'limit',
  'payload',
];

/**
 * Este erro do `/recipients` é "bloco grande demais"?
 *
 * - `413` (Payload Too Large): sempre, por definição.
 * - `400`: só quando o CORPO fala de tamanho/limite.
 * - qualquer outro status (401 chave revogada, 404 broadcast inexistente, 5xx):
 *   NÃO. Retentar menor não conserta nenhum deles.
 */
export function isChunkTooLargeError(
  status: number | undefined,
  body: ZernioErrorBodyLike,
): boolean {
  if (status === 413) return true;
  if (status !== 400) return false;
  const text = errorText(body);
  return TOO_LARGE_HINTS.some((hint) => text.includes(hint));
}

/**
 * O PRÓXIMO tamanho de bloco depois de uma recusa por tamanho.
 *
 * Preferimos o número que o PRÓPRIO SERVIDOR citou ("Maximum 100 recipients per
 * request") — é a única fonte confiável do limite real que existe, e ela só
 * aparece quando batemos nele. Mas só o aceitamos quando ele REDUZ: um servidor
 * que diz "máximo 100" ao recusar um bloco de 50 está falando de outra coisa, e
 * repetir 50 daria o mesmo erro para sempre.
 *
 * Sem número utilizável no corpo: metade. `1` já é o mínimo — devolve `null`
 * (desiste, e quem chama trata como falha do lote em vez de girar).
 */
export function shrinkChunk(
  current: number,
  body: ZernioErrorBodyLike,
): number | null {
  if (current <= 1) return null;

  const halved = Math.max(1, Math.floor(current / 2));

  const match = /(\d+)/.exec(errorText(body));
  if (match) {
    const stated = Number(match[1]);
    // Só serve se for um limite MENOR do que o que acabou de ser recusado.
    if (Number.isFinite(stated) && stated >= 1 && stated < current) {
      return stated;
    }
  }

  return halved;
}
