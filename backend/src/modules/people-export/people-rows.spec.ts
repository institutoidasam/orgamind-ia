import { describe, expect, it } from 'vitest';
import {
  PEOPLE_EXPORT_COLUMNS,
  type PeopleColumn,
} from '../../shared/spreadsheet/people-columns';
import type { AssignmentLine } from '../users/assignment-timeline';
import {
  comparePeopleEntries,
  peopleCells,
  selectIndexEntry,
  type ExportNameMaps,
  type ExportViewer,
  type PeopleCandidateRow,
  type PeopleDetailRow,
  type PeopleIndexEntry,
  type PeopleSelection,
} from './people-rows';

const TODAY = '2026-11-19';
const PAST = '2026-10-01';
const PHONE = '+5592991112008';
const PHONE_NAME = '92 99111-2008';
const PHONE_NATIONAL = '(92) 99111-2008';
const MASKED = '•••• 2008';
const NAMES: ExportNameMaps = {
  sectors: new Map([
    ['s1', 'Logística'],
    ['s2', 'Almoxarifado'],
    ['s3', 'Expedição'],
  ]),
  shifts: new Map([
    ['t1', 'Manhã'],
    ['t2', 'Noite'],
  ]),
  levels: new Map([['n1', 'Pleno']]),
};
const ADMIN: ExportViewer = { isAdmin: true, fullPhone: true, reach: null };
const MANAGER: ExportViewer = {
  isAdmin: false,
  fullPhone: true,
  reach: ['s1'],
};

function candidate(over: Partial<PeopleCandidateRow> = {}): PeopleCandidateRow {
  return {
    id: 'p1',
    name: 'Ana Souza',
    hasAccess: false,
    sectorId: 's1',
    shiftId: 't1',
    levelId: 'n1',
    ...over,
  };
}

function detail(over: Partial<PeopleDetailRow> = {}): PeopleDetailRow {
  return {
    id: 'p1',
    registration: 'M-100',
    name: 'Ana Souza',
    phoneE164: PHONE,
    jobTitle: 'Operadora',
    contactAuthorization: 'AUTORIZADO',
    authorizationSource: 'TERMO_ASSINADO',
    authorizationNote: null,
    authorizationDate: '2026-03-05',
    isActive: true,
    hasAccess: false,
    ...over,
  };
}

function select(
  row: PeopleCandidateRow,
  viewer: ExportViewer,
  over: Partial<PeopleSelection> = {},
  lines: AssignmentLine[] = [],
): PeopleIndexEntry | null {
  const selection = {
    sectorIds: viewer.reach,
    shiftId: null,
    date: TODAY,
    today: TODAY,
    ...over,
  };
  return selectIndexEntry({ row, lines, selection, viewer, names: NAMES });
}

function selectOrFail(
  row: PeopleCandidateRow,
  viewer: ExportViewer,
  over: Partial<PeopleSelection> = {},
): PeopleIndexEntry {
  const entry = select(row, viewer, over);
  if (!entry) throw new Error('pessoa fora do recorte');
  return entry;
}

function asRecord(cells: string[]): Record<PeopleColumn, string> {
  expect(cells).toHaveLength(PEOPLE_EXPORT_COLUMNS.length);
  return Object.fromEntries(
    PEOPLE_EXPORT_COLUMNS.map((column, i) => [column, cells[i]]),
  ) as Record<PeopleColumn, string>;
}

/** Segunda passada: `detail` espelha a linha do índice, salvo o que `over` mudar. */
function cellsOf(
  row: PeopleCandidateRow,
  viewer: ExportViewer,
  over: Partial<PeopleDetailRow> = {},
): Record<PeopleColumn, string> {
  const entry = selectOrFail(row, viewer);
  const det = detail({
    id: row.id,
    name: row.name,
    hasAccess: row.hasAccess,
    ...over,
  });
  return asRecord(peopleCells({ detail: det, entry, names: NAMES, viewer }));
}

function order(rows: PeopleCandidateRow[], viewer: ExportViewer): string[] {
  return rows
    .flatMap((row) => select(row, viewer) ?? [])
    .sort(comparePeopleEntries)
    .map((entry) => entry.id);
}

describe('people-rows: telefone e nome por linha (GX4)', () => {
  it('ADMIN com a chave: telefone completo no formato nacional, inclusive de pessoa com login', () => {
    const r = cellsOf(candidate({ hasAccess: true, name: PHONE_NAME }), ADMIN);
    expect([r.telefone, r.nome, r.tem_acesso]).toEqual([
      PHONE_NATIONAL,
      PHONE_NAME,
      'Sim',
    ]);
  });

  it('gestor com a chave: completo só de pessoa sem login; com login sai mascarado, e o nome-telefone também', () => {
    const free = cellsOf(candidate({ name: PHONE_NAME }), MANAGER);
    const logged = cellsOf(
      candidate({ id: 'p2', name: PHONE_NAME, hasAccess: true }),
      MANAGER,
    );
    expect([free.telefone, free.nome]).toEqual([PHONE_NATIONAL, PHONE_NAME]);
    expect([logged.telefone, logged.nome]).toEqual([MASKED, MASKED]);
  });

  it('sem a chave: telefone e nome-telefone mascarados para todos', () => {
    const noKey = [
      { ...ADMIN, fullPhone: false },
      { ...MANAGER, fullPhone: false },
    ];
    for (const viewer of noKey) {
      const r = cellsOf(candidate({ name: PHONE_NAME }), viewer);
      expect([r.telefone, r.nome]).toEqual([MASKED, MASKED]);
    }
  });
});

// Setor s1 até 31/10 e s2 desde 01/11 (hoje, pelo espelho, a pessoa está em s2).
const LINES: AssignmentLine[] = [
  {
    sectorId: 's1',
    shiftId: 't1',
    levelId: 'n1',
    from: null,
    to: '2026-10-31',
  },
  {
    sectorId: 's2',
    shiftId: 't2',
    levelId: null,
    from: '2026-11-01',
    to: null,
  },
];
const MOVED: AssignmentLine[] = [
  {
    sectorId: 's2',
    shiftId: 't1',
    levelId: null,
    from: null,
    to: '2026-11-18',
  },
];

describe('people-rows: data passada não amplia (GX4)', () => {
  it('data passada: vínculo da linha que cobre a data; quem hoje está fora do alcance sai mascarado', () => {
    const row = candidate({
      sectorId: 's2',
      shiftId: 't2',
      levelId: null,
      name: PHONE_NAME,
    });
    expect(select(row, MANAGER, { date: PAST }, LINES)).toMatchObject({
      sectorName: 'Logística',
      phoneFull: false,
      displayName: MASKED,
      assignment: { sectorId: 's1', shiftId: 't1', levelId: 'n1' },
    });
    expect(select(row, ADMIN, { date: PAST }, LINES)).toMatchObject({
      phoneFull: true,
      displayName: PHONE_NAME,
    });
    expect(select(row, ADMIN, { date: PAST })).toMatchObject({
      sectorName: 'Almoxarifado',
      assignment: { sectorId: 's2', shiftId: 't2' },
    });
  });
});

describe('people-rows: recorte por setor, turno e alcance (GX5)', () => {
  it('gestor: pessoa cujo setor na data não é do alcance fica fora; filtro de turno pelo vínculo da data', () => {
    const row = candidate({ sectorId: 's1', shiftId: 't2' });
    expect(select(row, MANAGER, { date: PAST }, MOVED)).toBeNull();
    expect(select(row, ADMIN, { date: PAST, shiftId: 't2' }, MOVED)).toBeNull();
    expect(
      select(row, ADMIN, { date: PAST, shiftId: 't1' }, MOVED),
    ).not.toBeNull();
    expect(select(row, ADMIN, { sectorIds: ['s3'] })).toBeNull();
    expect(select(row, { ...MANAGER, reach: null })).toBeNull();
  });
});

const lone = candidate({
  id: 'p0',
  name: null,
  sectorId: null,
  shiftId: null,
  levelId: null,
});

// Aqui `sectorIds` é nulo ou alheio ao alcance: só a checagem de alcance barra.
describe('people-rows: alcance conferido sem o filtro de setor (DX5)', () => {
  it('gestor: setor da data fora do alcance fica fora, sem filtro de setor ou pedindo o setor alheio', () => {
    const row = candidate({ sectorId: 's1', shiftId: 't2' });
    expect(
      select(row, MANAGER, { date: PAST, sectorIds: null }, MOVED),
    ).toBeNull();
    expect(
      select(row, MANAGER, { date: PAST, sectorIds: ['s2'] }, MOVED),
    ).toBeNull();
    expect(
      select(row, ADMIN, { date: PAST, sectorIds: ['s2'] }, MOVED),
    ).not.toBeNull();
    expect(select(row, MANAGER, { sectorIds: null })).not.toBeNull();
  });

  it('pessoa sem setor: só o ADMIN a vê; o gestor não a vê nem sem filtro de setor', () => {
    expect(select(lone, MANAGER, { sectorIds: null })).toBeNull();
    expect(select(lone, ADMIN, { sectorIds: null })).not.toBeNull();
  });
});

describe('people-rows: ordem e células vazias (DX7)', () => {
  it('pessoa sem telefone e sem setor no arquivo do ADMIN: telefone vazio, setor vazio, por último', () => {
    const r = cellsOf(lone, ADMIN, { phoneE164: null });
    expect([r.telefone, r.setor, r.turno, r.nivel]).toEqual(['', '', '', '']);
    expect(select(lone, ADMIN, { sectorIds: ['s1'] })).toBeNull();
    expect(order([lone, candidate()], ADMIN)).toEqual(['p1', 'p0']);
  });

  it('ordena por setor, nome exibido e id; o nome mascarado decide a posição', () => {
    const rows = [
      candidate({ id: 'b', name: 'Bruno' }),
      candidate({ id: 'a2', name: 'Ana' }),
      candidate({ id: 'a1', name: 'Ana' }),
      candidate({ id: 'c', name: 'Caio', sectorId: 's2' }),
      lone,
    ];
    expect(order(rows, ADMIN)).toEqual(['c', 'a1', 'a2', 'b', 'p0']);
    const phones = [
      candidate({ id: 'x', name: '92 98888-9000', hasAccess: true }),
      candidate({ id: 'y', name: '92 99999-1000', hasAccess: true }),
    ];
    expect(order(phones, ADMIN)).toEqual(['x', 'y']);
    expect(order(phones, MANAGER)).toEqual(['y', 'x']);
  });
});

const FILLED_CELLS = [
  'M-100',
  'Ana Souza',
  PHONE_NATIONAL,
  'Operadora',
  'Expedição', // setor, turno e nível inativos continuam com o nome
  'Noite',
  'Pleno',
  'Não',
  'Ficha de admissão',
  'ver ficha',
  '05/03/2026',
  'Inativa',
  'Sim',
];

describe('people-rows: células', () => {
  it('peopleCells: 13 colunas na ordem, Sim/Não, origens, data DD/MM/AAAA, Ativa/Inativa e nomes de setor, turno e nível inativos', () => {
    const row = candidate({ sectorId: 's3', shiftId: 't2', hasAccess: true });
    const filled = cellsOf(row, ADMIN, {
      contactAuthorization: 'NAO_AUTORIZADO',
      authorizationSource: 'FICHA_ADMISSAO',
      authorizationNote: 'ver ficha',
      isActive: false,
    });
    expect(PEOPLE_EXPORT_COLUMNS.map((column) => filled[column])).toEqual(
      FILLED_CELLS,
    );
    const blank = cellsOf(candidate(), ADMIN, {
      registration: null,
      jobTitle: null,
      authorizationSource: null,
      authorizationDate: null,
    });
    expect(blank).toMatchObject({
      matricula: '',
      funcao: '',
      origem_autorizacao: '',
      data_autorizacao: '',
      autorizacao_contato: 'Sim',
      situacao: 'Ativa',
      tem_acesso: 'Não',
    });
  });

  it('nome nulo sai vazio e o e-mail nunca entra nas linhas', () => {
    const row = { ...candidate({ name: null }), email: 'ana@exemplo.com' };
    const entry = selectOrFail(row, ADMIN);
    const cells = peopleCells({
      detail: detail({ name: null }),
      entry,
      names: NAMES,
      viewer: ADMIN,
    });
    expect(entry.displayName).toBe('');
    expect(cells[1]).toBe('');
    expect(JSON.stringify([entry, cells])).not.toContain('ana@exemplo.com');
  });
});

describe('people-rows: segunda passada (DX4)', () => {
  const secondPass = (
    entry: PeopleIndexEntry,
    viewer: ExportViewer,
    over: Partial<PeopleDetailRow>,
  ) =>
    asRecord(
      peopleCells({ detail: detail(over), entry, names: NAMES, viewer }),
    );

  it('peopleCells: nome é o displayName do índice; telefone completo só com entry.phoneFull e (ADMIN ou sem login agora), senão mascarado', () => {
    const entry = selectOrFail(candidate({ name: PHONE_NAME }), MANAGER);
    expect(entry.phoneFull).toBe(true);
    const free = secondPass(entry, MANAGER, { hasAccess: false });
    expect([free.telefone, free.nome]).toEqual([PHONE_NATIONAL, PHONE_NAME]);
    const gainedLogin = secondPass(entry, MANAGER, { hasAccess: true });
    expect([gainedLogin.telefone, gainedLogin.nome]).toEqual([MASKED, MASKED]);
    const admin = secondPass(entry, ADMIN, { hasAccess: true });
    expect([admin.telefone, admin.nome]).toEqual([PHONE_NATIONAL, PHONE_NAME]);
    const noPhone = secondPass(entry, ADMIN, { phoneE164: null });
    expect(noPhone.telefone).toBe('');
    const noKey = selectOrFail(candidate({ name: PHONE_NAME }), {
      ...ADMIN,
      fullPhone: false,
    });
    expect(secondPass(noKey, ADMIN, {}).telefone).toBe(MASKED);
    const renamed = selectOrFail(candidate({ name: 'Ana Souza' }), ADMIN);
    expect(secondPass(renamed, ADMIN, { name: 'Outro nome' }).nome).toBe(
      'Ana Souza',
    );
  });
});
