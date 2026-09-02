import type { FilterGroup } from './schemas';

/**
 * "Adicionar contato específico" (pedido do cliente, 2026-08-25) — soma
 * contatos avulsos ao público, por cima de QUALQUER filtro (cidade/grupo/
 * tags, ou o construtor avançado) e de qualquer exclusão já aplicada
 * (inválidos confirmados, quem já recebeu). Um OU no nível mais externo: o
 * contato escolhido a dedo entra INDEPENDENTE de bater com o resto do
 * filtro — essa é a diferença entre "somar ao público" e "mais uma regra E".
 *
 * O contrato do filtro (`filterGroupSchema`) não tem um campo `id` — só
 * `phoneE164` identifica um contato sem ambiguidade, então a regra usa
 * `phoneE164 in [...]` (o mesmo padrão de ARRAY_OPS que o FilterBuilder já
 * usa para `in`/`notIn`).
 *
 * Retorna `base` INALTERADO (mesma referência) quando não há telefone
 * nenhum — nunca uma regra `in` com array vazio, que o backend trataria como
 * "nenhum contato" e inverteria a intenção de um OU vazio.
 */
export function materializeExtraContacts(
  base: FilterGroup,
  phones: string[],
): FilterGroup {
  if (phones.length === 0) return base;

  return {
    combinator: 'or',
    rules: [base, { field: 'phoneE164', op: 'in', value: phones }],
  };
}
