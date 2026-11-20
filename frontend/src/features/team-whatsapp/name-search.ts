/** Nome sem acento, sem diferença de maiúsculas e sem espaço nas pontas: a forma em que a busca compara (DG13). */
export function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/** O nome (já como a tela o mostra) contém o termo; termo vazio casa com todos. */
export function matchesName(name: string, q: string): boolean {
  const term = normalizeName(q);
  return term === "" || normalizeName(name).includes(term);
}

/** Há termo de busca (depois de normalizar)? Termo só de espaços é vazio. */
export const hasTerm = (q: string): boolean => normalizeName(q) !== "";

/** Aviso da lista que a busca por nome zerou: a lista existe, mas ninguém casa com o termo. */
export const NO_NAME_MATCH_TEXT = "Ninguém com esse nome nesta lista.";

/** Contagem no título de uma lista filtrada pela busca: "n de m" enquanto houver termo; sem termo, o total. */
export const narrowedCount = (
  shown: number,
  total: number,
  q: string,
): string => (hasTerm(q) ? `${shown} de ${total}` : String(total));
