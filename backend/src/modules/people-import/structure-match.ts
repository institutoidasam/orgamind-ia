import { ROW_TEXT, type StructureKind as StructureLabel } from './row-texts';

export type StructureKind = 'sector' | 'shift' | 'level';

/** `code` só existe em setor; turno e nível trazem `null`. */
export type StructureOption = {
  id: string;
  name: string;
  code: string | null;
  isActive: boolean;
};

/** Todas as opções de cada estrutura, ativas e inativas. */
export type StructureCatalog = Readonly<
  Record<StructureKind, readonly StructureOption[]>
>;

export type StructureMatch =
  { ok: true; id: string } | { ok: false; reason: string };

const LABEL: Record<StructureKind, StructureLabel> = {
  sector: 'Setor',
  shift: 'Turno',
  level: 'Nível',
};

/** Sem acento, minúsculas, espaços colapsados e sem as pontas. */
export function normalizeStructureName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** O texto já normalizado casa com o nome da opção ou, no setor, com o código. */
function matches(option: StructureOption, normalized: string): boolean {
  if (normalizeStructureName(option.name) === normalized) return true;
  return (
    option.code !== null && normalizeStructureName(option.code) === normalized
  );
}

/** Sem alcance (`null`), toda opção serve; com alcance, só as listadas. */
function reachFilter(reach: readonly string[] | null): (id: string) => boolean {
  return reach === null ? () => true : (id) => reach.includes(id);
}

/**
 * Setor, turno ou nível pelo nome (setor também pelo código) entre as opções
 * ativas (E4). `reach` é o alcance de quem não é ADMIN (`null` = ADMIN) e só
 * restringe o setor: setor fora do alcance e setor inexistente dão a mesma
 * resposta, `notInReach` (EX16), e a ambiguidade só conta os do alcance.
 * O valor igual ao atual vale mesmo inativo, mas, no setor de quem não é
 * ADMIN, só se o atual estiver no alcance. O chamador não busca célula vazia.
 */
export function matchStructure(input: {
  kind: StructureKind;
  text: string;
  catalog: StructureCatalog;
  currentId: string | null;
  reach: readonly string[] | null;
}): StructureMatch {
  const { kind, text, catalog, currentId, reach } = input;
  const normalized = normalizeStructureName(text);
  const restricted = kind === 'sector' && reach !== null;
  const allowed = reachFilter(restricted ? reach : null);
  const options = catalog[kind];

  const current = options.find((o) => o.id === currentId);
  if (current && allowed(current.id) && matches(current, normalized)) {
    return { ok: true, id: current.id };
  }

  const found = options.filter(
    (o) => o.isActive && allowed(o.id) && matches(o, normalized),
  );
  if (found.length === 1) return { ok: true, id: found[0].id };
  if (found.length > 1) {
    return { ok: false, reason: ROW_TEXT.ambiguous(LABEL[kind], text) };
  }
  return {
    ok: false,
    reason: restricted
      ? ROW_TEXT.notInReach(text)
      : ROW_TEXT.notFound(LABEL[kind], text),
  };
}

/** Nome da opção (ativa ou não), ou `null` sem id ou sem a opção. */
export function structureName(
  catalog: StructureCatalog,
  kind: StructureKind,
  id: string | null,
): string | null {
  if (id === null) return null;
  return catalog[kind].find((o) => o.id === id)?.name ?? null;
}
