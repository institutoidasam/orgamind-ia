import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IMPORT_FIELDS,
  ROW_CLASSES,
  type ColumnMapping,
  type RowClass,
} from '../../schemas/contracts/people-import.schema';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import { BatchClassifier, buildLookup, countByClass } from './batch-classifier';
import { rowCellsOf, type RawFields } from './cell-values';
import { classifyRow } from './classify-row';
import {
  CATALOG,
  TODAY,
  cellsOf,
  personWith,
  rowOf,
} from './classify-row.fixtures';
import { toImportActor, type ImportActor } from './import-actor';
import type { ImportPerson, RowCells, RowVerdict } from './import-person';
import type { RowRecord } from './people-import.repository';
import { ROW_TEXT } from './row-texts';

// Spy sobre a função real: prova o lookup que cada linha recebe (EX17.3).
vi.mock('./classify-row', async (importOriginal) => {
  const original = await importOriginal<typeof import('./classify-row')>();
  return { ...original, classifyRow: vi.fn(original.classifyRow) };
});

type Line = { rowNumber: number; cells: RowCells };
type KeyQuery = {
  registrationKeys: readonly string[];
  phones: readonly string[];
};

const ADMIN = toImportActor({ ...actorWith('ADMIN'), managedSectorIds: [] });
const SUPERVISOR = toImportActor({
  ...actorWith('SUPERVISOR'),
  managedSectorIds: ['s-prod'],
});
const NO_KEY = toImportActor({
  ...actorWith('SUPERVISOR', { revoke: ['telefone.ver_completo'] }),
  managedSectorIds: ['s-prod'],
});
const MARINA = personWith();

/** Campo i na coluna i, como `rowCellsOf` grava as células. */
const MAPPING = Object.fromEntries(
  IMPORT_FIELDS.map((field, index) => [field, index]),
) as ColumnMapping;

function line(rowNumber: number, cells: Partial<RawFields>): Line {
  const values = IMPORT_FIELDS.map((field) => cells[field] ?? '');
  return { rowNumber, cells: rowCellsOf(values) };
}

/** Repositório falso que responde como o real: casa matrícula ou telefone exato. */
function classifierOver(people: readonly ImportPerson[]) {
  const matches = (person: ImportPerson, query: KeyQuery) =>
    (person.registrationKey !== null &&
      query.registrationKeys.includes(person.registrationKey)) ||
    (person.phoneE164 !== null && query.phones.includes(person.phoneE164));
  const repository = {
    findPeopleByKeys: vi.fn((query: KeyQuery) =>
      Promise.resolve(people.filter((person) => matches(person, query))),
    ),
    loadCatalog: vi.fn(() => Promise.resolve(CATALOG)),
  };
  return { repository, classifier: new BatchClassifier(repository as never) };
}

function classify(
  actor: ImportActor,
  rows: readonly Line[],
  people: readonly ImportPerson[] = [],
) {
  const { classifier } = classifierOver(people);
  return classifier.classify({ rows, mapping: MAPPING, actor, today: TODAY });
}

/** Matrícula, matrícula com outra caixa, telefone formatado, exemplo e repetida. */
const KEYS_FILE = [
  line(2, { registration: 'MAT-01', name: 'Marina', phone: '+5592991110001' }),
  line(3, { registration: 'Mat-05', name: 'Rafael Lima', sector: 'Produção' }),
  line(4, {
    name: 'Nova Pessoa',
    phone: '(92) 99111-0003',
    sector: 'Produção',
  }),
  line(5, { registration: 'EXEMPLO', name: 'Ex', phone: '+5592991110004' }),
  line(6, { registration: 'mat-01', name: 'Outra', phone: '+5592991110005' }),
];

/** Linha que não entra: sem prévia, plano nem pessoa. */
function notWritten(
  classification: RowClass,
  reasons: string[] = [],
): RowVerdict {
  return {
    classification,
    reasons,
    warnings: [],
    preview: null,
    plan: null,
    personId: null,
  };
}

beforeEach(() => {
  vi.mocked(classifyRow).mockClear();
});

describe('BatchClassifier.classify — consulta única do lote', () => {
  it.each([
    ['ADMIN', ADMIN],
    ['quem tem telefone.ver_completo', SUPERVISOR],
  ])(
    'consulta pessoas uma vez com todas as matrículas e grafias de telefone (%s)',
    async (_label, actor) => {
      const { repository, classifier } = classifierOver([MARINA]);
      await classifier.classify({
        rows: KEYS_FILE,
        mapping: MAPPING,
        actor,
        today: TODAY,
      });
      expect(repository.findPeopleByKeys).toHaveBeenCalledTimes(1);
      expect(repository.findPeopleByKeys).toHaveBeenCalledWith({
        registrationKeys: ['mat-01', 'mat-05'],
        phones: [
          '+5592991110001',
          '+559291110001',
          '+5592991110003',
          '+559291110003',
        ],
      });
      expect(repository.loadCatalog).toHaveBeenCalledTimes(1);
    },
  );
});

describe('BatchClassifier.classify — consulta de quem não vê telefone completo', () => {
  it('S1-2: sem telefone.ver_completo, a consulta de pessoas do lote não recebe nenhum telefone', async () => {
    const owner = phoneOnly('p-dona', '+5592991110003');
    const { repository, classifier } = classifierOver([MARINA, owner]);
    await classifier.classify({
      rows: KEYS_FILE,
      mapping: MAPPING,
      actor: NO_KEY,
      today: TODAY,
    });
    expect(repository.findPeopleByKeys).toHaveBeenCalledTimes(1);
    expect(repository.findPeopleByKeys).toHaveBeenCalledWith({
      registrationKeys: ['mat-01', 'mat-05'],
      phones: [],
    });
    const lookups = vi.mocked(classifyRow).mock.calls.map(([i]) => i.lookup);
    expect(lookups).toHaveLength(4);
    expect(lookups[0].byRegistrationKey.get('mat-01')).toBe(MARINA);
    expect(lookups.map((lookup) => lookup.byPhone.size)).toEqual([0, 0, 0, 0]);
  });
});

describe('BatchClassifier.classify — sem a chave, o número cadastrado não aparece', () => {
  const FILE = [
    line(2, {
      name: 'Nova Pessoa',
      phone: '+5592991110001',
      sector: 'Produção',
    }),
  ];

  it.each([
    ['sem login no alcance', MARINA],
    ['com login', personWith({ hasAccess: true })],
    ['fora do alcance', personWith({ sectorId: 's-log' })],
    [
      'na outra grafia do 9º dígito',
      personWith({ phoneE164: '+559291110001' }),
    ],
  ])(
    'S1-7: dona do número %s dá o mesmo lote e as mesmas contagens do número livre',
    async (_label, owner) => {
      const taken = await classify(NO_KEY, FILE, [owner]);
      const free = await classify(NO_KEY, FILE);
      expect(taken).toEqual(free);
      expect(free.rows[0].verdict?.classification).toBe('CREATE');
      // Com a chave, o mesmo cadastro acha a dona: o caso distingue os dois.
      const admin = await classify(ADMIN, FILE, [owner]);
      expect(admin.rows[0].verdict?.classification).not.toBe('CREATE');
    },
  );
});

describe('BatchClassifier.classify — classificação das linhas', () => {
  const NEW = {
    name: 'Nova Pessoa',
    phone: '+5592991110009',
    sector: 'Produção',
  };
  const BAD_PHONE = { registration: 'MAT-09', name: 'Ana', phone: 'abc' };
  it('classifica o lote: duplicadas depois da primeira, as demais por classifyRow', async () => {
    const file: [number, Partial<RawFields>][] = [
      [2, cellsOf(MARINA)],
      [3, {}],
      [4, { registration: 'mat-01', name: 'Outra Marina' }],
      [5, NEW],
      [6, BAD_PHONE],
      [7, { name: 'Mesma Nova', phone: '(92) 99111-0009' }],
    ];
    const rows = file.map(([rowNumber, cells]) => line(rowNumber, cells));
    const result = await classify(ADMIN, rows, [MARINA]);
    const lookup = buildLookup([MARINA]);
    const direct = (cells: Partial<RawFields>) =>
      classifyRow({
        ...rowOf(cells),
        lookup,
        catalog: CATALOG,
        actor: ADMIN,
        today: TODAY,
      });
    expect(result.rows).toEqual(
      rows.map((row) => expect.objectContaining(row) as unknown),
    );
    expect(result.rows.map((row) => row.verdict)).toEqual([
      direct(cellsOf(MARINA)),
      direct({}),
      notWritten('DUPLICATE', [ROW_TEXT.duplicateOf(2)]),
      direct(NEW),
      notWritten('INVALID', [ROW_TEXT.invalidPhone]),
      notWritten('DUPLICATE', [ROW_TEXT.duplicateOf(5)]),
    ]);
    expect(result.counts).toEqual({
      CREATE: 1,
      UPDATE: 0,
      UNCHANGED: 1,
      INVALID: 1,
      DUPLICATE: 2,
      CONFLICT: 0,
      IGNORED: 1,
    });
  });
});

/** Pessoa sem matrícula gravada, só com o telefone. */
function phoneOnly(id: string, phoneE164: string | null): ImportPerson {
  return personWith({
    id,
    phoneE164,
    registration: null,
    registrationKey: null,
  });
}

describe('buildLookup', () => {
  it('buildLookup indexa cada grafia do telefone e a chave da matrícula', () => {
    const people = [
      MARINA,
      phoneOnly('p-legado', '+559291110002'),
      phoneOnly('p-sem-chaves', null),
    ];
    const { byRegistrationKey, byPhone } = buildLookup(people);
    expect([...byRegistrationKey]).toEqual([['mat-01', MARINA]]);
    expect(
      Object.fromEntries([...byPhone].map(([phone, p]) => [phone, p.id])),
    ).toEqual({
      '+5592991110001': 'p-marina',
      '+559291110001': 'p-marina',
      '+559291110002': 'p-legado',
      '+5592991110002': 'p-legado',
    });
  });

  const twin = phoneOnly('p-gemeo', '+559291110001');
  it.each([
    ['gravada antes', [MARINA, twin]],
    ['gravada depois', [twin, MARINA]],
  ])(
    'buildLookup: o número gravado vale sobre a grafia derivada (%s)',
    (_label, people) => {
      const { byPhone } = buildLookup(people);
      expect(byPhone.get('+5592991110001')?.id).toBe('p-marina');
      expect(byPhone.get('+559291110001')?.id).toBe('p-gemeo');
    },
  );
});

describe('countByClass', () => {
  it('countByClass conta todas as classes, inclusive zero', () => {
    const record = (classification: RowClass): RowRecord => ({
      rowNumber: 2,
      cells: {},
      verdict: notWritten(classification),
    });
    const counts = countByClass([
      record('CREATE'),
      record('CREATE'),
      record('INVALID'),
      { rowNumber: 5, cells: {}, verdict: null },
    ]);
    expect(Object.keys(counts)).toEqual([...ROW_CLASSES]);
    expect(counts).toEqual({
      CREATE: 2,
      UPDATE: 0,
      UNCHANGED: 0,
      INVALID: 1,
      DUPLICATE: 0,
      CONFLICT: 0,
      IGNORED: 0,
    });
  });
});
