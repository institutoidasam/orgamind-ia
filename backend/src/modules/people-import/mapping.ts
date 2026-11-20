import {
  IMPORT_FIELDS,
  type ColumnMapping,
  type ImportField,
} from '../../schemas/contracts/people-import.schema';

/** NFD sem diacríticos, minúsculas, sem espaço, `_` nem `-`. */
export function normalizeHeader(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\s_-]/g, '');
}

/** Cabeçalhos já normalizados que cada campo reconhece (E3). */
export const FIELD_SYNONYMS: Readonly<Record<ImportField, readonly string[]>> =
  {
    registration: ['matricula', 'registro', 'id', 'cracha'],
    name: ['nome', 'colaborador', 'funcionario'],
    phone: ['telefone', 'celular', 'whatsapp', 'fone'],
    jobTitle: ['funcao', 'cargo'],
    sector: ['setor', 'area', 'departamento'],
    shift: ['turno'],
    level: ['nivel'],
    // Os nomes das colunas do modelo e, depois, os rótulos que a tela exibe.
    authorization: [
      'autorizacaocontato',
      'autorizacao',
      'autorizacaodecontato',
    ],
    authorizationSource: ['origemautorizacao', 'origem', 'origemdaautorizacao'],
    authorizationNote: ['detalheorigem', 'detalhe', 'detalhedaorigem'],
    authorizationDate: ['dataautorizacao', 'datadaautorizacao'],
  };

/** Por campo, a primeira coluna que casa; coluna usada não serve a outro campo. */
export function suggestMapping(headers: readonly string[]): ColumnMapping {
  const normalized = headers.map(normalizeHeader);
  const used = new Set<number>();
  const mapping = {} as ColumnMapping;
  for (const field of IMPORT_FIELDS) {
    const index = normalized.findIndex(
      (header, i) => !used.has(i) && FIELD_SYNONYMS[field].includes(header),
    );
    mapping[field] = index === -1 ? null : index;
    if (index !== -1) used.add(index);
  }
  return mapping;
}

export function mappedColumns(mapping: ColumnMapping): number[] {
  const indexes = Object.values(mapping).filter((i) => i !== null);
  return [...new Set(indexes)].sort((a, b) => a - b);
}

/**
 * O mesmo mapeamento, campo a campo; chave ausente no gravado vale "Não usar".
 * Confere o que a tela mostrou (EX7) e o que o remapear gravou (EX6).
 */
export function sameMapping(
  stored: Partial<Record<string, unknown>>,
  mapping: ColumnMapping,
): boolean {
  return IMPORT_FIELDS.every(
    (field) => (stored[field] ?? null) === (mapping[field] ?? null),
  );
}

export function unmappedColumns(
  mapping: ColumnMapping,
  headerCount: number,
): number[] {
  const mapped = new Set(mappedColumns(mapping));
  return Array.from({ length: headerCount }, (_, i) => i).filter(
    (i) => !mapped.has(i),
  );
}

const PROBLEM = {
  missingColumn: 'Coluna inexistente no arquivo.',
  repeatedColumn: 'Cada coluna serve a um campo só.',
  needKey:
    'Escolha a coluna de Nome e pelo menos uma entre Telefone e Matrícula.',
  needSector:
    'Escolha a coluna de Setor: quem não é administrador informa o setor em todas as linhas.',
} as const;

/** Por que o mapeamento ainda não permite seguir; `null` quando está completo. */
export function mappingProblem(
  mapping: ColumnMapping,
  input: { headerCount: number; isAdmin: boolean },
): string | null {
  const used = Object.values(mapping).filter((i) => i !== null);
  if (used.some((i) => i >= input.headerCount)) return PROBLEM.missingColumn;
  if (new Set(used).size !== used.length) return PROBLEM.repeatedColumn;
  const hasKey = mapping.phone !== null || mapping.registration !== null;
  if (mapping.name === null || !hasKey) return PROBLEM.needKey;
  if (!input.isAdmin && mapping.sector === null) return PROBLEM.needSector;
  return null;
}
