import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { hasPermission } from '../../shared/authz/permissions';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { BatchSummary } from '../../schemas/contracts/people-import.schema';
import type { FieldChange } from '../../shared/audit/audit-change';
import type { SheetData } from '../../shared/spreadsheet/sheet-data';
import { fromDbDate } from '../staff-schedule/civil-date';
import { loadImportActor } from './import-actor';
import { importReason } from './import-trail';
import {
  type E2EIds,
  type ImportRow,
  TESTCONTAINERS_ENABLED,
  TODAY,
  YESTERDAY,
  confirmAll,
  createPerson,
  e2e,
  nextPhone,
  phoneCell,
  readErrorReport,
  setupImportE2E,
  stopImportE2E,
  uploadCsv,
  useE2EClock,
  writeAll,
} from './people-import.e2e.fixtures';
import { ROW_TEXT } from './row-texts';

// Ponta a ponta da importação (aceites 11, 14, 16 e 26 e S1-5): serviços reais
// sobre Postgres real, com o relógio fixo em 19/11/2026 (GX4).
let ids: E2EIds;

// Sem TESTCONTAINERS_ENABLED=1 os describes são pulados e o banco não sobe.
beforeAll(async () => {
  if (TESTCONTAINERS_ENABLED) ids = (await setupImportE2E()).ids;
}, 240_000);

afterAll(stopImportE2E);
beforeEach(useE2EClock);
afterEach(() => vi.useRealTimers());

/** Linha, nome e motivo de cada linha do `errors.csv` (a coluna do motivo é a última). */
function reportEntries(sheet: SheetData) {
  const at = (name: string) => sheet.headers.indexOf(name);
  return sheet.rows.map((row) => ({
    line: row.cells[at('linha')],
    name: row.cells[at('nome')],
    reason: row.cells[at('motivo')],
  }));
}

const namesIn = async (...names: string[]) =>
  (
    await e2e().prisma.user.findMany({
      where: { name: { in: names } },
      select: { name: true },
      orderBy: { name: 'asc' },
    })
  ).map((user) => user.name);

/** Linhas do lote como estão no banco, na ordem do arquivo. */
const rowsOf = (batchId: string) =>
  e2e().prisma.peopleImportRow.findMany({
    where: { batchId },
    orderBy: { rowNumber: 'asc' },
  });

describe.skipIf(!TESTCONTAINERS_ENABLED)('remapear em outra aba (EX7)', () => {
  it('confirmar com o mapeamento antigo: 409 preview_changed e nada muda', async () => {
    const seen = await uploadCsv(ids.admin, [
      {
        matricula: 'M-0801',
        nome: 'Bruno Duas Abas',
        telefone: phoneCell(nextPhone()),
        setor: 'Operação',
      },
    ]);
    // a outra aba deixa a matrícula de fora; esta tela ainda mostra a anterior
    const remapped = { ...seen.mapping, registration: null };
    await e2e().preview.remap(ids.admin, seen.id, remapped);
    const before = await rowsOf(seen.id);

    await expect(
      confirmAll(ids.admin, seen.id, { mapping: seen.mapping }),
    ).rejects.toMatchObject({
      code: 'people_import.preview_changed',
      status: 409,
    });
    expect(await rowsOf(seen.id)).toStrictEqual(before);
    expect(
      await e2e().prisma.peopleImportBatch.findUniqueOrThrow({
        where: { id: seen.id },
        select: { status: true, confirmedById: true, mapping: true },
      }),
    ).toStrictEqual({
      status: 'PREVIEW',
      confirmedById: null,
      mapping: remapped,
    });
  });
});

describe.skipIf(!TESTCONTAINERS_ENABLED)('aceite 11 (T02)', () => {
  it('aceite 11 (T02): válida, duplicada e inválida; só a confirmada entra; o relatório traz as outras duas', async () => {
    const batch = await uploadCsv(ids.admin, [
      {
        matricula: 'M-1101',
        nome: 'Ana Válida',
        telefone: phoneCell(nextPhone()),
        setor: 'Operação',
      },
      {
        matricula: 'M-1101',
        nome: 'Ana Repetida',
        telefone: phoneCell(nextPhone()),
        setor: 'Operação',
      },
      { matricula: 'M-1103', nome: 'Carla Inválida', setor: 'Operação' },
    ]);

    expect(batch.counts).toMatchObject({ CREATE: 1, DUPLICATE: 1, INVALID: 1 });
    const page = await e2e().query.rows(ids.admin, batch.id, { page: 1 });
    expect(
      page.items.map((row) => [row.rowNumber, row.classification, row.reasons]),
    ).toEqual([
      [2, 'CREATE', []],
      [3, 'DUPLICATE', [ROW_TEXT.duplicateOf(2)]],
      [4, 'INVALID', [ROW_TEXT.newNeedsPhone]],
    ]);

    await confirmAll(ids.admin, batch.id);
    const done = await writeAll(ids.admin, batch.id);

    expect(done).toMatchObject({
      situation: 'COMPLETED',
      hasErrorReport: true,
    });
    expect(done.progress).toMatchObject({ created: 1, failed: 0 });
    expect(
      await namesIn('Ana Válida', 'Ana Repetida', 'Carla Inválida'),
    ).toEqual(['Ana Válida']);
    expect(reportEntries(await readErrorReport(ids.admin, batch.id))).toEqual([
      { line: '3', name: 'Ana Repetida', reason: ROW_TEXT.duplicateOf(2) },
      { line: '4', name: 'Carla Inválida', reason: ROW_TEXT.newNeedsPhone },
    ]);
  });
});

/** A ficha da pessoa: o que a planilha pode mudar (e o telefone, que ela não toca). */
const fichaOf = async (id: string) => {
  const user = await e2e().prisma.user.findUniqueOrThrow({ where: { id } });
  const { name, jobTitle, phoneE164, sectorId, shiftId, levelId } = user;
  return { name, jobTitle, phoneE164, sectorId, shiftId, levelId };
};

/** Linhas do histórico de vínculo, da mais antiga à mais nova. */
const timelineOf = async (userId: string) =>
  (
    await e2e().prisma.userAssignment.findMany({
      where: { userId },
      orderBy: { validFrom: 'asc' },
    })
  ).map((row) => ({
    sectorId: row.sectorId,
    shiftId: row.shiftId,
    levelId: row.levelId,
    from: row.validFrom && fromDbDate(row.validFrom),
    to: row.validTo && fromDbDate(row.validTo),
  }));

/** Eventos da pessoa na trilha, do mais antigo ao mais novo. */
const trailOf = (subjectUserId: string) =>
  e2e().prisma.auditEvent.findMany({
    where: { subjectUserId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { action: true, reason: true, actorId: true, changes: true },
  });

/** Setor, turno e nível de Beto: de Operação/Noite/Funcionário para Logística/Manhã/Líder. */
const placement = (when: 'before' | 'after') =>
  when === 'before'
    ? { sectorId: ids.operation, shiftId: ids.night, levelId: ids.employee }
    : { sectorId: ids.logistics, shiftId: ids.morning, levelId: ids.leader };

const BETO_FILE_ROW = {
  matricula: 'M-1401',
  nome: 'Beto Novo',
  funcao: 'Encarregado',
  setor: 'Logística',
  turno: 'Manhã',
  nivel: 'Líder',
};
const BETO_DIFF = [
  ['name', 'Beto Antigo', 'Beto Novo'],
  ['jobTitle', 'Auxiliar', 'Encarregado'],
  ['sector', 'Operação', 'Logística'],
  ['shift', 'Noite', 'Manhã'],
  ['level', 'Funcionário', 'Líder'],
];

describe.skipIf(!TESTCONTAINERS_ENABLED)('aceite 14', () => {
  it('aceite 14: atualizar por matrícula mostra antes e depois e grava ficha, trilha e vínculo com o motivo', async () => {
    const { id, phone } = await createPerson({
      ...placement('before'),
      name: 'Beto Antigo',
      registration: 'M-1401',
      jobTitle: 'Auxiliar',
    });
    const batch = await uploadCsv(ids.admin, [BETO_FILE_ROW]);

    const [row] = (await e2e().query.rows(ids.admin, batch.id, { page: 1 }))
      .items;
    expect(row.classification).toBe('UPDATE');
    expect(row.diff.map((d) => [d.field, d.before, d.after])).toEqual(
      BETO_DIFF,
    );

    await confirmAll(ids.admin, batch.id);
    await writeAll(ids.admin, batch.id);

    expect(await fichaOf(id)).toEqual({
      ...placement('after'),
      name: 'Beto Novo',
      jobTitle: 'Encarregado',
      phoneE164: phone,
    });
    expect(await timelineOf(id)).toEqual([
      {
        ...placement('before'),
        from: fromDbDate(YESTERDAY),
        to: fromDbDate(YESTERDAY),
      },
      { ...placement('after'), from: TODAY, to: null },
    ]);
    const events = await trailOf(id);
    expect(events.map((e) => [e.action, e.reason, e.actorId])).toEqual([
      ['user.person_created', null, ids.admin],
      ['user.profile_updated', importReason('equipe.csv'), ids.admin],
    ]);
    const changed = (events[1].changes as unknown as FieldChange[]).map(
      (change) => change.field,
    );
    expect(changed).toEqual(
      expect.arrayContaining(['name', 'sector', 'shift', 'level']),
    );
  });
});

/** Classificação de cada linha da prévia, na ordem do arquivo. */
const classesOf = async (batch: BatchSummary) =>
  (await e2e().query.rows(ids.admin, batch.id, { page: 1 })).items.map(
    (row) => row.classification,
  );

describe.skipIf(!TESTCONTAINERS_ENABLED)('aceite 16', () => {
  it('aceite 16: reimportar a mesma planilha não cria ninguém', async () => {
    const rows: ImportRow[] = [
      {
        matricula: 'M-1601',
        nome: 'Dora Com Matrícula',
        telefone: phoneCell(nextPhone()),
        setor: 'Operação',
      },
      {
        nome: 'Edu Só Telefone',
        telefone: phoneCell(nextPhone()),
        setor: 'Operação',
      },
      { matricula: 'M-1603', nome: 'Fátima Sem Telefone', setor: 'Operação' },
      {
        matricula: 'M-1601',
        nome: 'Dora Repetida',
        telefone: phoneCell(nextPhone()),
        setor: 'Operação',
      },
    ];
    const first = await uploadCsv(ids.admin, rows);
    await confirmAll(ids.admin, first.id);
    await writeAll(ids.admin, first.id);
    const people = await e2e().prisma.user.count();

    const second = await uploadCsv(ids.admin, rows, 'equipe-de-novo.csv');

    expect(first.counts).toMatchObject({ CREATE: 2, INVALID: 1, DUPLICATE: 1 });
    expect(await classesOf(second)).toEqual([
      'UNCHANGED',
      'UNCHANGED',
      'INVALID',
      'DUPLICATE',
    ]);
    expect(second.counts).toMatchObject({ CREATE: 0, UPDATE: 0, UNCHANGED: 2 });
    await expect(confirmAll(ids.admin, second.id)).rejects.toMatchObject({
      code: 'people_import.nothing_selected',
    });
    expect(await e2e().prisma.user.count()).toBe(people);
  });
});

const NOT_MAPPED = 'DOC-FICT-2601';

describe.skipIf(!TESTCONTAINERS_ENABLED)('aceite 26', () => {
  it('aceite 26: depois de gravar, o conteúdo da linha sai do banco', async () => {
    const e164 = nextPhone();
    const phone = phoneCell(e164);
    const batch = await uploadCsv(ids.admin, [
      {
        matricula: 'M-2601',
        nome: 'Gil Gravado',
        telefone: phone,
        setor: 'Operação',
        documento: NOT_MAPPED,
      },
      {
        matricula: 'M-2602',
        nome: 'Hana Inválida',
        setor: 'Operação',
        documento: 'DOC-FICT-2602',
      },
    ]);
    const stored = () => rowsOf(batch.id);
    expect(JSON.stringify(await stored())).toContain(NOT_MAPPED);

    await confirmAll(ids.admin, batch.id);
    expect(JSON.stringify(await stored())).not.toContain('DOC-FICT');

    await writeAll(ids.admin, batch.id);
    const [written, invalid] = await stored();
    expect(written).toMatchObject({
      cells: null,
      plan: null,
      preview: null,
      outcome: 'CREATED',
    });
    expect(written.personId).toEqual(expect.any(String));
    for (const secret of ['Gil Gravado', phone, e164.slice(3)]) {
      expect(JSON.stringify(written)).not.toContain(secret);
    }
    // a linha que não entrou guarda só as colunas mapeadas, para o relatório
    expect(invalid.cells).toMatchObject({ '1': 'Hana Inválida' });
  });
});

/** A trilha do fim do lote; só números (sem nome nem telefone de ninguém). */
const completedEvent = (entityId: string) =>
  e2e().prisma.auditEvent.findFirstOrThrow({
    where: { action: 'people_import.completed', entityId },
  });

const NAMES_S15 = ['Iara Nova', 'Joel Ocupado', 'Kátia Nova'];

/** Três pessoas novas em Logística; a do meio traz o número de quem já está cadastrada. */
const s15Rows = (taken: string): ImportRow[] =>
  [nextPhone(), taken, nextPhone()].map((phone, index) => ({
    nome: NAMES_S15[index],
    telefone: phoneCell(phone),
    setor: 'Logística',
  }));

/** Nada que identifique alguém: nem nomes do arquivo, nem os números (E.164 ou de planilha). */
function expectNoPersonalData(
  event: object,
  input: { phone: string; words: string[] },
): void {
  const { phone, words } = input;
  const text = JSON.stringify(event);
  for (const secret of [
    ...NAMES_S15,
    ...words,
    phone.slice(3),
    phoneCell(phone),
  ]) {
    expect(text).not.toContain(secret);
  }
}

describe.skipIf(!TESTCONTAINERS_ENABLED)('S1-5', () => {
  it('S1-5: sem a chave, número ocupado falha; as outras linhas entram; relatório, phoneTaken e trilha só com números', async () => {
    const owner = await createPerson({ name: 'Dona do Número' });
    const taken = owner.phone;
    const batch = await uploadCsv(ids.blind, s15Rows(taken));
    expect(batch).toMatchObject({
      phoneCheckDeferred: true,
      counts: { CREATE: 3 },
    });

    await confirmAll(ids.blind, batch.id);
    const done = await writeAll(ids.blind, batch.id);

    expect(done.progress).toMatchObject({
      created: 2,
      failed: 1,
      phoneTaken: 1,
    });
    expect(await namesIn(...NAMES_S15)).toEqual(['Iara Nova', 'Kátia Nova']);
    expect(
      (await rowsOf(batch.id)).map((row) => [row.outcome, row.outcomeReason]),
    ).toEqual([
      ['CREATED', null],
      ['FAILED', ROW_TEXT.phoneTaken],
      ['CREATED', null],
    ]);
    expect(reportEntries(await readErrorReport(ids.blind, batch.id))).toEqual([
      { line: '3', name: 'Joel Ocupado', reason: ROW_TEXT.phoneTaken },
    ]);
    const event = await completedEvent(batch.id);
    expect(event.changes).toEqual(
      expect.arrayContaining([{ field: 'phoneTaken', before: null, after: 1 }]),
    );
    expectNoPersonalData(event, { phone: taken, words: ['Dona'] });
  });
});

// As fixtures são a base da T22b: confere os três atores que ela vai usar.
describe.skipIf(!TESTCONTAINERS_ENABLED)('fixtures: atores semeados', () => {
  it('ADMIN alcança tudo; os dois gestores importam e editam, só o primeiro vê telefone completo', async () => {
    const load = (id: string) =>
      loadImportActor(e2e().prisma as unknown as PrismaService, id);
    const [admin, manager, blind] = await Promise.all(
      [ids.admin, ids.manager, ids.blind].map(load),
    );

    expect([admin.reach, manager.reach, blind.reach]).toEqual([
      null,
      [ids.operation],
      [ids.logistics],
    ]);
    for (const actor of [manager, blind]) {
      expect(hasPermission(actor.policy, 'pessoas.importar')).toBe(true);
      expect(actor.canEditPeople).toBe(true);
    }
    expect([admin.fullPhone, manager.fullPhone, blind.fullPhone]).toEqual([
      true,
      true,
      false,
    ]);
  });
});
