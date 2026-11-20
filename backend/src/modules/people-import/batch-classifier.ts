import { Injectable } from '@nestjs/common';
import {
  ROW_CLASSES,
  type ColumnMapping,
  type RowClass,
} from '../../schemas/contracts/people-import.schema';
import { brazilianPhoneVariants } from '../contacts/phone.util';
import type { CivilDate } from '../staff-schedule/civil-date';
import {
  parseAuthorizationCells,
  type AuthorizationCells,
} from './authorization-plan';
import { fieldsOf, parseFields, type ParsedFields } from './cell-values';
import { classifyRow, seesFullPhone, type PeopleLookup } from './classify-row';
import { duplicateOf } from './duplicates';
import type { ImportActor } from './import-actor';
import type { ImportPerson, RowCells, RowVerdict } from './import-person';
import {
  PeopleImportRepository,
  type RowRecord,
} from './people-import.repository';
import { ROW_TEXT } from './row-texts';

export type BatchInput = {
  /** Linhas na ordem do arquivo (EX31). */
  rows: readonly { rowNumber: number; cells: RowCells }[];
  mapping: ColumnMapping;
  actor: ImportActor;
  today: CivilDate;
};

export type BatchClassification = {
  rows: RowRecord[];
  counts: Record<RowClass, number>;
};

type ReadRow = {
  rowNumber: number;
  cells: RowCells;
  fields: ParsedFields;
  authorization: AuthorizationCells;
};

type KeyQuery = { registrationKeys: string[]; phones: string[] };

/**
 * Pessoas do lote pela chave da matrícula e por cada grafia do telefone
 * (`brazilianPhoneVariants`). O número gravado vale sobre a grafia derivada de
 * outra pessoa, para que a leitura pela forma exata ache o dono dela. Se duas
 * pessoas são gêmeas de 8 e 9 dígitos, cada uma é dona da sua grafia gravada e
 * a linha acha o gêmeo da grafia em que foi escrita (T15 M2); a grafia
 * derivada vale só para quem não a tem como dona (a primeira pessoa a trazê-la).
 */
export function buildLookup(people: readonly ImportPerson[]): PeopleLookup {
  const byRegistrationKey = new Map<string, ImportPerson>();
  const byPhone = new Map<string, ImportPerson>();
  for (const person of people) {
    if (person.registrationKey) {
      byRegistrationKey.set(person.registrationKey, person);
    }
    if (person.phoneE164 === null) continue;
    const [exact, ...others] = brazilianPhoneVariants(person.phoneE164);
    byPhone.set(exact, person);
    for (const variant of others) {
      if (!byPhone.has(variant)) byPhone.set(variant, person);
    }
  }
  return { byRegistrationKey, byPhone };
}

/** Contadores da prévia (spec E5): todas as classes, inclusive 0; linha sem veredito não conta. */
export function countByClass(
  rows: readonly RowRecord[],
): Record<RowClass, number> {
  const counts = Object.fromEntries(
    ROW_CLASSES.map((classification) => [classification, 0]),
  ) as Record<RowClass, number>;
  for (const { verdict } of rows) {
    if (verdict) counts[verdict.classification] += 1;
  }
  return counts;
}

function readRow(
  row: { rowNumber: number; cells: RowCells },
  input: BatchInput,
): ReadRow {
  const raw = fieldsOf(row.cells, input.mapping);
  return {
    rowNumber: row.rowNumber,
    cells: row.cells,
    fields: parseFields(raw),
    authorization: parseAuthorizationCells(raw, input.today),
  };
}

/**
 * Chaves da consulta única do lote (EX15 passo 5): as matrículas e, só para
 * quem vê telefone completo, todas as grafias dos telefones. Sem a chave, a
 * consulta não recebe nenhum telefone do arquivo (EX17.3, Conselho S).
 */
function lookupKeys(rows: readonly ReadRow[], actor: ImportActor): KeyQuery {
  const registrationKeys = new Set<string>();
  const phones = new Set<string>();
  for (const { fields } of rows) {
    if (fields.registration) registrationKeys.add(fields.registration.key);
    if (fields.phoneE164 === null || !seesFullPhone(actor)) continue;
    for (const variant of brazilianPhoneVariants(fields.phoneE164)) {
      phones.add(variant);
    }
  }
  return { registrationKeys: [...registrationKeys], phones: [...phones] };
}

/** Linha repetida (EX31): não entra, sem prévia, plano nem pessoa. */
function duplicateVerdict(first: number): RowVerdict {
  return {
    classification: 'DUPLICATE',
    reasons: [ROW_TEXT.duplicateOf(first)],
    warnings: [],
    preview: null,
    plan: null,
    personId: null,
  };
}

/**
 * Classifica o lote inteiro (EX15, spec E4): lê as células de cada linha,
 * decide as repetidas para o lote (EX31) e passa as demais ao `classifyRow`.
 * Pessoas e estrutura são consultadas uma vez por lote, nunca por linha. Para
 * quem não vê telefone completo, `byPhone` chega vazio: a prévia não diz se um
 * número já existe (defesa em profundidade do EX17.3).
 */
@Injectable()
export class BatchClassifier {
  constructor(private readonly repository: PeopleImportRepository) {}

  async classify(input: BatchInput): Promise<BatchClassification> {
    const read = input.rows.map((row) => readRow(row, input));
    const duplicates = duplicateOf(read);
    const toLookUp = read.filter(
      ({ rowNumber, fields }) =>
        !fields.isBlank && !fields.isExample && !duplicates.has(rowNumber),
    );
    const [people, catalog] = await Promise.all([
      this.repository.findPeopleByKeys(lookupKeys(toLookUp, input.actor)),
      this.repository.loadCatalog(),
    ]);
    const found = buildLookup(people);
    const lookup: PeopleLookup = seesFullPhone(input.actor)
      ? found
      : { byRegistrationKey: found.byRegistrationKey, byPhone: new Map() };
    const { actor, today } = input;
    const rows = read.map(({ rowNumber, cells, fields, authorization }) => {
      const first = duplicates.get(rowNumber);
      const verdict =
        first === undefined
          ? classifyRow({
              fields,
              authorization,
              lookup,
              catalog,
              actor,
              today,
            })
          : duplicateVerdict(first);
      return { rowNumber, cells, verdict };
    });
    return { rows, counts: countByClass(rows) };
  }
}
