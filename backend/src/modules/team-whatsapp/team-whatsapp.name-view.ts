import {
  hasPermission,
  type PermissionHolder,
} from '../../shared/authz/permissions';
import { nameView } from '../../shared/authz/phone-visibility';

/**
 * Nome de pessoa na saída do envio (D11). Aqui não há a regra `hidden` do setor
 * (B3): `full` = o ator, lido do banco na requisição, tem `telefone.ver_completo`.
 * Só a SAÍDA muda; `userName`, `targetLabel` e a foto da escala ficam gravados
 * com o nome real.
 */
export const seesFullPhone = (actor: PermissionHolder): boolean =>
  hasPermission(actor, 'telefone.ver_completo');

/** Autor do envio (usuário com login): o nome sai pela mesma regra; `id` e e-mail ficam. */
export function authorView<A extends { name: string | null }>(
  author: A | null,
  full: boolean,
): A | null {
  return author ? { ...author, name: nameView(author.name, { full }) } : null;
}

const collator = new Intl.Collator('pt-BR');

/**
 * Lista já mapeada pelo `nameView`. Com a chave a ordem fica como veio; sem ela,
 * ordena pelo nome EXIBIDO (a máscara), dentro de cada `group`: ordenar pelo
 * nome real deixaria descobrir o número por tentativa (renomear a pessoa e ver
 * de que lado do `•••• 1234` ela cai). Máscaras iguais (mesmos 4 últimos
 * dígitos) desempatam pelo `id`, nunca pela ordem de entrada, que é a do nome
 * real.
 */
export function sortByViewedName<T>(
  items: readonly T[],
  full: boolean,
  keyOf: (item: T) => { group: number; name: string; id: string },
): T[] {
  if (full) return [...items];
  return [...items].sort((a, b) => {
    const [ka, kb] = [keyOf(a), keyOf(b)];
    return (
      ka.group - kb.group ||
      collator.compare(ka.name, kb.name) ||
      collator.compare(ka.id, kb.id)
    );
  });
}

type SectorName = string | null | undefined;

const bySectorName = (a: SectorName, b: SectorName): number =>
  Number(a == null) - Number(b == null) || collator.compare(a ?? '', b ?? '');

/**
 * Posição de cada setor: a foto da escala lista um setor por vez. Com a chave,
 * pela primeira aparição. Sem ela, pelo nome do setor (sem nome por último): a
 * primeira aparição segue a ordem do nome real e revelaria de que lado dele
 * cai o de outro setor.
 */
export function sectorRank(
  people: readonly { sectorName?: string | null }[],
  full: boolean,
): (person: { sectorName?: string | null }) => number {
  const names = [...new Set(people.map((p) => p.sectorName))];
  if (!full) names.sort(bySectorName);
  const rank = new Map(names.map((name, i) => [name, i]));
  return (p) => rank.get(p.sectorName) ?? 0;
}
