import type {
  FilterGroup,
  Rule,
  HistoryRule,
} from '../../schemas/contracts/filter.schema';
import { REACHED_STATUSES } from './batch-audience';
import { ValidationError } from '../../shared/errors/domain.error';

/**
 * ★ OS CAMPOS EM QUE `notIn` É REESCRITO COMO `OR` COM O RAMO NULL.
 *
 * `campo NOT IN (…)` é TRÊS-VALORADO no SQL: para uma linha com NULL avalia
 * NULL, e a linha some do resultado. `lastFailureReason` é NULL em quase toda
 * a base, então um `notIn` pelado transformaria "excluir inválidos
 * confirmados" em "incluir só quem já falhou por outro motivo".
 *
 * A lista é DELIBERADAMENTE curta. `name`, `city` e `group` também são
 * nuláveis, e o mesmo argumento valeria para eles — mas mudá-los AGORA
 * alargaria, em silêncio, a audiência de todo segmento já salvo, no meio de
 * uma campanha eleitoral. Fica como legado conhecido; mudar isso é decisão de
 * produto, com aviso, não efeito colateral desta correção.
 */
const NULL_SAFE_NOT_IN_FIELDS = new Set<Rule['field']>(['lastFailureReason']);

function ruleToPrisma(r: Rule): Record<string, unknown> {
  const f = r.field;
  switch (r.op) {
    case 'eq':
      return { [f]: r.value };
    case 'ne':
      return { [f]: { not: r.value } };
    case 'contains':
      if (f === 'tags') return { tags: { has: r.value } };
      return { [f]: { contains: r.value, mode: 'insensitive' } };
    case 'startsWith':
      return { [f]: { startsWith: r.value, mode: 'insensitive' } };
    case 'endsWith':
      return { [f]: { endsWith: r.value, mode: 'insensitive' } };
    case 'in':
      return { [f]: { in: r.value } };
    case 'notIn':
      if (NULL_SAFE_NOT_IN_FIELDS.has(f)) {
        return { OR: [{ [f]: null }, { [f]: { notIn: r.value } }] };
      }
      return { [f]: { notIn: r.value } };
    case 'isNull':
      return { [f]: null };
    case 'notNull':
      return { [f]: { not: null } };
  }
}

// F1 implementa event:'received'; F2 acende event:'failed' (abaixo). Em
// ambos, templateIds já foram fundidos em campaignIds pelo resolver (Task 3)
// ANTES do toPrismaWhere — aqui lê só r.campaignIds.
function historyRuleToPrisma(r: HistoryRule): Record<string, unknown> {
  if (r.event === 'received') {
    const clause = {
      campaignId: { in: r.campaignIds ?? [] },
      direction: 'OUTBOUND',
      status: { in: REACHED_STATUSES },
    };
    return { messages: r.negate ? { none: clause } : { some: clause } };
  }
  if (r.event === 'failed') {
    const clause: Record<string, unknown> = {
      campaignId: { in: r.campaignIds ?? [] },
      direction: 'OUTBOUND',
      status: 'FAILED',
    };
    if (r.failureReason) clause.failureReason = r.failureReason;
    return { messages: r.negate ? { none: clause } : { some: clause } };
  }
  // event 'replied' é aceso por F3 — até lá, NÃO É SEGURO devolver `{}` aqui.
  // `{}` é neutro dentro de um AND, mas dentro de um OR (`OR:[cond, {}]`) o
  // Prisma trata `{}` como sempre-verdadeiro: o OR inteiro colapsa para TRUE e
  // casa a base inteira de contatos, silenciosamente, com qualquer que seja o
  // `cond` ao lado. Lançar aqui garante que nenhuma query é computada errada,
  // independente do combinator do grupo pai. Quando F3 implementar o ramo
  // replied, remove o event do throw abaixo — o contrato do schema com os 3
  // events permanece intacto.
  throw new ValidationError(
    `O filtro usa o evento de histórico "${r.event}", que ainda não foi implementado. Use apenas os eventos "recebeu" (received) e "falhou" (failed) por enquanto.`,
    `history filter event '${r.event}' is not supported yet`,
    'campaign.history_event_not_supported',
  );
}

function groupToPrisma(g: FilterGroup): Record<string, unknown> {
  if (!g.rules.length) return {};
  const arr = g.rules.map((r) =>
    'combinator' in r
      ? groupToPrisma(r)
      : 'kind' in r
        ? historyRuleToPrisma(r)
        : ruleToPrisma(r),
  );
  return g.combinator === 'and' ? { AND: arr } : { OR: arr };
}

/**
 * ★ Decisão do cliente, 2026-08-25 — opt-out DEIXOU de ser um filtro
 * automático do PÚBLICO da campanha.
 *
 * Até aqui, `toPrismaWhere` sempre embutia `{ optedOut: false }` — todo
 * público (prévia, criação, lotes, segmentos) excluía quem tinha opt-out,
 * incondicionalmente e sem forma de o operador ver/mudar isso. O cliente
 * pediu para tirar essa exclusão automática do PÚBLICO: um contato com
 * opt-out volta a casar com o filtro normalmente (entra na contagem, na
 * amostra, na audiência).
 *
 * A PROTEÇÃO CONTRA ENVIO A QUEM PEDIU PARA NÃO RECEBER continua, mas
 * mudou de forma (commit b2d1808):
 *   • O cache `Contact.optedOut` foi removido dos TRÊS caminhos de envio
 *     (`dispatchAudience`, `send-message.processor.ts`, `zernio-broadcast-
 *     send.service.ts`) — a única fonte de verdade agora é a
 *     `SuppressionList` (phoneHash), que é ABSOLUTA em todos eles.
 *   • O gate de consentimento POR FINALIDADE continua ativo em ambos os
 *     workers (1-a-1 e broadcast) — revogação de uma finalidade específica
 *     não suprime globalmente.
 *
 * Uma exceção LOCAL: `ConsentBulkGrantService#resolve` (commit 1a01d49)
 * restaurou a exclusão de `{ optedOut: true }` APENAS naquele serviço,
 * porque a remoção de `toPrismaWhere` atingiu um quarto consumidor não
 * previsto e abria o risco de CONCEDER consentimento a quem já revogou
 * fora da SuppressionList.
 */
export function toPrismaWhere(filter: FilterGroup): Record<string, unknown> {
  return groupToPrisma(filter);
}
