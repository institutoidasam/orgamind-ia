import type { FilterGroup } from './schemas';

/**
 * "EXCLUIR INVÁLIDOS CONFIRMADOS" — as 4 regras da spec (B.4), materializadas.
 *
 * ── POR QUE 4 REGRAS E NÃO UMA ───────────────────────────────────────────────
 * O toggle anterior era "Apenas números válidos (WhatsApp)" e emitia UMA regra:
 * `whatsappValid eq true`. Numa base em que `whatsappValid` é NULL para quase
 * todo mundo — que é exatamente a base do cliente, porque nada valida número
 * desde a saída da Evolution — isso seleciona ZERO pessoas. A campanha sai
 * vazia, sem erro nenhum, e o operador acha que o filtro "não pegou".
 *
 * A pergunta certa não é "quem é comprovadamente válido?" e sim "quem NÃO é
 * comprovadamente inválido?" — e essa, no SQL, precisa do ramo NULL explícito
 * dos dois lados: `campo NOT IN (…)` não casa NULL.
 *
 * Este módulo é o CONTRATO que a Fase A consome (o assistente liga o toggle por
 * padrão em campanha nova). Espelha `excludeInvalidWhere()` de
 * `backend/src/shared/contact-validity.ts`.
 */
export const INVALID_FAILURE_REASONS = [
  'SEM_WHATSAPP',
  'TELEFONE_INVALIDO',
] as const;

export function excludeInvalidGroup(): FilterGroup {
  return {
    combinator: 'and',
    rules: [
      {
        combinator: 'or',
        rules: [
          { field: 'whatsappValid', op: 'isNull' },
          { field: 'whatsappValid', op: 'eq', value: true },
        ],
      },
      {
        combinator: 'or',
        rules: [
          { field: 'lastFailureReason', op: 'isNull' },
          {
            field: 'lastFailureReason',
            op: 'notIn',
            value: [...INVALID_FAILURE_REASONS],
          },
        ],
      },
    ],
  };
}

type AnyNode = {
  combinator?: unknown;
  rules?: unknown;
  field?: unknown;
  op?: unknown;
  value?: unknown;
};

function isRule(
  n: unknown,
  field: string,
  op: string,
  value?: unknown,
): boolean {
  const r = n as AnyNode | null;
  if (!r || r.combinator !== undefined) return false;
  if (r.field !== field || r.op !== op) return false;
  if (value === undefined) return r.value === undefined;
  return JSON.stringify(r.value) === JSON.stringify(value);
}

/**
 * Reconhece o grupo POR ESTRUTURA, ignorando chaves extras — o FilterBuilder
 * pendura um `__uid` em cada nó, e uma comparação por igualdade profunda
 * falharia justamente onde o toggle precisa funcionar.
 */
export function isExcludeInvalidGroup(node: unknown): boolean {
  const g = node as AnyNode | null;
  if (!g || g.combinator !== 'and' || !Array.isArray(g.rules)) return false;
  if (g.rules.length !== 2) return false;
  const [a, b] = g.rules as AnyNode[];

  const validOk =
    a?.combinator === 'or' &&
    Array.isArray(a.rules) &&
    a.rules.length === 2 &&
    isRule(a.rules[0], 'whatsappValid', 'isNull') &&
    isRule(a.rules[1], 'whatsappValid', 'eq', true);

  const reasonOk =
    b?.combinator === 'or' &&
    Array.isArray(b.rules) &&
    b.rules.length === 2 &&
    isRule(b.rules[0], 'lastFailureReason', 'isNull') &&
    isRule(b.rules[1], 'lastFailureReason', 'notIn', [
      ...INVALID_FAILURE_REASONS,
    ]);

  return validOk && reasonOk;
}

export function hasExcludeInvalid(g: FilterGroup): boolean {
  return g.rules.some(isExcludeInvalidGroup);
}

/** Idempotente: ligar duas vezes não duplica o grupo. */
export function withExcludeInvalid(g: FilterGroup): FilterGroup {
  if (hasExcludeInvalid(g)) return g;
  return { ...g, rules: [...g.rules, excludeInvalidGroup()] };
}

export function withoutExcludeInvalid(g: FilterGroup): FilterGroup {
  return { ...g, rules: g.rules.filter((r) => !isExcludeInvalidGroup(r)) };
}

/**
 * O filtro LEGADO `whatsappValid eq true`, que campanhas e segmentos salvos
 * antes desta fase ainda carregam. Ele não é apagado automaticamente (o
 * operador pode ter querido exatamente isso), mas a tela AVISA: numa base sem
 * validação, ele zera a audiência.
 */
export function hasLegacyValidOnlyRule(g: FilterGroup): boolean {
  return g.rules.some((r) => isRule(r, 'whatsappValid', 'eq', true));
}
