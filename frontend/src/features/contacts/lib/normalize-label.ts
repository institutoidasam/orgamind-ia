/**
 * Pedido do cliente: "Manaus" e "manaus" viram dois registros porque cidade
 * (e grupo, e tag) são hoje texto livre. A correção normaliza só a
 * COMPARAÇÃO (maiúsc./minúsc., acento, espaçamento) — o valor GRAVADO
 * continua sendo o rótulo escolhido pelo operador, nunca uma forma
 * canônica artificial que ninguém digitou.
 */

/** Chave de comparação: sem acento, sem caixa, espaços colapsados e aparados. */
export function normalizeForCompare(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('pt-BR');
}

/** Espaços aparados/colapsados, sem mexer em caixa ou acento. */
export function cleanLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * Resolve o rótulo definitivo a gravar para um valor digitado: se ele
 * normaliza para o MESMO valor de uma opção já cadastrada, reaproveita o
 * rótulo já existente (evita duplicar "Manaus"/"manaus"); senão, mantém o
 * que o operador digitou (só limpo de espaços).
 */
export function resolveLabel(typed: string, options: readonly string[]): string {
  const cleaned = cleanLabel(typed);
  if (!cleaned) return cleaned;
  const target = normalizeForCompare(cleaned);
  const existing = options.find((o) => normalizeForCompare(o) === target);
  return existing ?? cleaned;
}
