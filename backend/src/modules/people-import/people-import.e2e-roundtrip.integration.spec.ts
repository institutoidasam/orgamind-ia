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
import type { BatchSummary } from '../../schemas/contracts/people-import.schema';
import { AuditRepository } from '../../shared/audit/audit.repository';
import { AuditService } from '../../shared/audit/audit.service';
import { DomainError } from '../../shared/errors/domain.error';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { SpreadsheetFormat } from '../../shared/spreadsheet/spreadsheet-writer';
import { PeopleExportRepository } from '../people-export/people-export.repository';
import { PeopleExportService } from '../people-export/people-export.service';
import { normalizeRegistration } from '../users/person-record';
import { loadImportActor } from './import-actor';
import { importReason } from './import-trail';
import type { ReservedRow } from './people-import-write.repository';
import {
  type E2EIds,
  type ImportRow,
  NOW,
  TESTCONTAINERS_ENABLED,
  confirmAll,
  createPerson,
  e2e,
  memorySink,
  nextPhone,
  phoneCell,
  setupImportE2E,
  stopImportE2E,
  uploadCsv,
  useE2EClock,
  writeAll,
} from './people-import.e2e.fixtures';

// Ponta a ponta 2 do Lote E (aceites 10, 21, 25 e 28, S1-7 e R4): o arquivo de
// pessoas vem do escritor real do Lote D e volta pela importação; a concorrência
// e a reserva vencida usam os repositórios reais, sobre Postgres real.
let ids: E2EIds;

// Sem TESTCONTAINERS_ENABLED=1 os describes são pulados e o banco não sobe.
beforeAll(async () => {
  if (TESTCONTAINERS_ENABLED) ids = (await setupImportE2E()).ids;
}, 240_000);

afterAll(stopImportE2E);
beforeEach(useE2EClock);
afterEach(() => vi.useRealTimers());

const FORMATS = ['csv', 'xlsx'] as const;
const db = () => e2e().prisma as unknown as PrismaService;

/** Exportação real do Lote D (serviço e repositório reais) para o `actor`, em bytes. */
async function exportPeopleFile(
  actor: string,
  format: SpreadsheetFormat,
  status: 'active' | 'all' = 'all',
): Promise<Buffer> {
  const audit = new AuditService(new AuditRepository(db()), {
    get: () => undefined,
  } as never);
  const service = new PeopleExportService(
    db(),
    new PeopleExportRepository(db()),
    audit,
  );
  const { sink, bytes } = memorySink();
  const query = { format, status, sectorId: undefined, shiftId: undefined };
  await service.exportPeople(actor, query, sink);
  return bytes;
}

/** Envia os bytes de um arquivo pronto, como o controller faria. */
function uploadFile(
  actor: string,
  buffer: Buffer,
  originalName: string,
): Promise<BatchSummary> {
  return e2e().preview.upload(actor, {
    originalName,
    size: buffer.length,
    buffer,
  });
}

const firstPage = (actor: string, batchId: string) =>
  e2e().query.rows(actor, batchId, { page: 1 });

/** Linhas do lote como estão no banco, na ordem do arquivo. */
const rowsOf = (batchId: string) =>
  e2e().prisma.peopleImportRow.findMany({
    where: { batchId },
    orderBy: { rowNumber: 'asc' },
  });

const namesIn = async (names: string[]) =>
  (
    await e2e().prisma.user.findMany({
      where: { name: { in: names } },
      select: { name: true },
      orderBy: { name: 'asc' },
    })
  ).map((user) => user.name);

const trailCount = (action: string, batchId: string) =>
  e2e().prisma.auditEvent.count({ where: { action, entityId: batchId } });

/** Banco das pessoas: usuários, contatos e a trilha que tem pessoa como assunto. */
async function snapshot() {
  const { prisma } = e2e();
  return {
    users: await prisma.user.findMany({ orderBy: { id: 'asc' } }),
    contacts: await prisma.contact.findMany({ orderBy: { id: 'asc' } }),
    personTrail: await prisma.auditEvent.count({
      where: { subjectUserId: { not: null } },
    }),
  };
}

/** Pessoa criada no cadastro manual, com as colunas de ficha que o teste precisa. */
async function personWith(
  name: string,
  more: Parameters<typeof createPerson>[0] = {},
) {
  return createPerson({ name, ...more });
}

/** Quem tem login recebe matrícula (linha sem matrícula nem telefone é Inválida por desenho). */
async function keyLoginActors() {
  for (const [id, registration] of [
    [ids.admin, 'RT-ADM'],
    [ids.manager, 'RT-GES'],
    [ids.blind, 'RT-CEG'],
  ]) {
    await e2e().prisma.user.update({
      where: { id },
      data: normalizeRegistration(registration),
    });
  }
}

/** Pessoa com setor inativo, pessoa inativa, nome de fórmula e "Cadastro anterior". */
async function seedRoundtripPeople() {
  const { prisma } = e2e();
  const archive = await prisma.sector.create({
    data: { name: 'Arquivo', code: 'ARQ' },
  });
  await personWith('Ana Completa', {
    registration: 'RT-001',
    jobTitle: 'Analista',
    sectorId: ids.operation,
    shiftId: ids.night,
    levelId: ids.leader,
    contactAuthorization: {
      status: 'AUTORIZADO',
      source: 'TERMO_ASSINADO',
      date: '2026-11-10',
    },
  });
  const inactive = await personWith('Bia Inativa', {
    registration: 'RT-002',
    sectorId: ids.operation,
  });
  await personWith('Caio Arquivado', { sectorId: archive.id });
  await personWith('=SOMA(1;2)', { sectorId: ids.operation });
  const earlier = await personWith('Eva Anterior', {
    registration: 'RT-005',
    sectorId: ids.operation,
  });
  await prisma.user.update({
    where: { id: inactive.id },
    data: { isActive: false },
  });
  await prisma.sector.update({
    where: { id: archive.id },
    data: { isActive: false },
  });
  await prisma.user.update({
    where: { id: earlier.id },
    data: {
      contactAuthorization: 'AUTORIZADO',
      authorizationSource: 'CADASTRO_ANTERIOR',
    },
  });
}

describe.skipIf(!TESTCONTAINERS_ENABLED)('aceite 10', () => {
  beforeAll(async () => {
    useE2EClock();
    await keyLoginActors();
    await seedRoundtripPeople();
    vi.useRealTimers();
  }, 60_000);

  it.each(FORMATS)(
    'aceite 10 (%s): a exportação do ADMIN, reimportada, dá Sem alteração em todas as linhas',
    async (format) => {
      const expected = await e2e().prisma.user.count({
        where: {
          OR: [{ registration: { not: null } }, { phoneE164: { not: null } }],
        },
      });
      const file = await exportPeopleFile(ids.admin, format);

      const batch = await uploadFile(ids.admin, file, `pessoas.${format}`);

      expect({ format, counts: batch.counts }).toMatchObject({
        format,
        counts: {
          UNCHANGED: expected,
          CREATE: 0,
          UPDATE: 0,
          INVALID: 0,
          CONFLICT: 0,
          DUPLICATE: 0,
        },
      });
      const page = await firstPage(ids.admin, batch.id);
      expect(page.total).toBe(expected);
      expect(new Set(page.items.map((row) => row.classification))).toEqual(
        new Set(['UNCHANGED']),
      );
      expect(page.items.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          'Ana Completa',
          'Bia Inativa',
          'Caio Arquivado',
          '=SOMA(1;2)',
          'Eva Anterior',
        ]),
      );
    },
  );
});

/** Em Logística (setor do gestor sem a chave): com matrícula, nome que é o telefone e só telefone. */
async function seedLogistics() {
  const own = nextPhone();
  await personWith('Dora Visível', {
    registration: 'M-28-1',
    sectorId: ids.logistics,
  });
  await personWith(phoneCell(own), {
    registration: 'M-28-2',
    phone: own,
    sectorId: ids.logistics,
  });
  await personWith('Edu Só Telefone', { sectorId: ids.logistics });
}

/** O arquivo do gestor sem a chave traz a máscara e nenhum telefone completo das pessoas dele. */
async function expectMaskedExport(text: string) {
  const people = await e2e().prisma.user.findMany({
    where: { sectorId: ids.logistics, phoneE164: { not: null } },
    select: { phoneE164: true },
  });
  const phones = people.flatMap((person) =>
    person.phoneE164 ? [phoneCell(person.phoneE164)] : [],
  );
  expect(phones.length).toBeGreaterThanOrEqual(3);
  expect(text).toContain('••••');
  expect(phones.filter((phone) => text.includes(phone))).toEqual([]);
}

/** Pessoas ativas de Logística com e sem matrícula: as que a exportação traz para o gestor. */
async function logisticsByRegistration() {
  const count = (registration: { not: null } | null) =>
    e2e().prisma.user.count({
      where: { sectorId: ids.logistics, isActive: true, registration },
    });
  return { keyed: await count({ not: null }), keyless: await count(null) };
}

describe.skipIf(!TESTCONTAINERS_ENABLED)('aceite 28', () => {
  it('aceite 28: exportação mascarada reimportada pelo ADMIN não grava nome nem telefone mascarado', async () => {
    await seedLogistics();
    const file = await exportPeopleFile(ids.blind, 'csv', 'active');
    await expectMaskedExport(file.toString('utf8'));
    const before = await snapshot();

    const batch = await uploadFile(ids.admin, file, 'pessoas-cego.csv');

    const { keyed, keyless } = await logisticsByRegistration();
    expect(batch.counts).toMatchObject({
      UNCHANGED: keyed,
      INVALID: keyless,
      CREATE: 0,
      UPDATE: 0,
    });
    // nada a gravar: o ADMIN não consegue nem confirmar, e o banco não muda
    await expect(confirmAll(ids.admin, batch.id)).rejects.toMatchObject({
      code: 'people_import.nothing_selected',
    });
    expect(await snapshot()).toStrictEqual(before);
  });
});

/** Nomes `<prefixo> 1..n`, um por linha nova. */
const namesOf = (prefix: string, total: number) =>
  Array.from({ length: total }, (_, index) => `${prefix} ${index + 1}`);

/** Linhas novas com matrícula, telefone e setor Operação (para o ADMIN). */
const adminRows = (names: string[], prefix: string): ImportRow[] =>
  names.map((nome, index) => ({
    matricula: `${prefix}-${index + 1}`,
    nome,
    telefone: phoneCell(nextPhone()),
    setor: 'Operação',
  }));

const isNotWriting = (error: unknown) =>
  error instanceof DomainError && error.code === 'people_import.not_writing';

/** Laço de blocos como o da tela; lote que acabou para outro laço (409) encerra este. */
async function blocksUntilDone(actor: string, batchId: string) {
  for (let block = 0; block < 500; block += 1) {
    try {
      const summary = await e2e().writer.writeBlock(actor, batchId);
      if (summary.situation !== 'WRITING') return summary;
    } catch (error) {
      if (isNotWriting(error)) return null;
      throw error;
    }
  }
  throw new Error('a gravação não terminou nos blocos esperados');
}

describe.skipIf(!TESTCONTAINERS_ENABLED)('aceite 21', () => {
  const NAMES = namesOf('Concorrente', 8);

  it('aceite 21: duas confirmações simultâneas confirmam uma vez e a segunda recebe 409', async () => {
    const batch = await uploadCsv(ids.admin, adminRows(NAMES, 'C21'));

    const settled = await Promise.allSettled([
      confirmAll(ids.admin, batch.id),
      confirmAll(ids.admin, batch.id),
    ]);

    const reasons = settled.flatMap((one) =>
      one.status === 'rejected' ? [one.reason as unknown] : [],
    );
    expect(settled.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
    expect(reasons).toMatchObject([
      { code: 'people_import.already_confirmed', status: 409 },
    ]);
    expect(await trailCount('people_import.confirmed', batch.id)).toBe(1);
  });

  it('aceite 21: dois laços de bloco juntos gravam cada pessoa uma vez e concluem uma vez', async () => {
    const batch = await uploadCsv(ids.admin, adminRows(NAMES, 'D21'));
    await confirmAll(ids.admin, batch.id);

    await Promise.all([
      blocksUntilDone(ids.admin, batch.id),
      blocksUntilDone(ids.admin, batch.id),
    ]);

    // o nome e o telefone são únicos por pessoa: 8 nomes, 8 pessoas
    expect(await namesIn(NAMES)).toEqual([...NAMES].sort());
    const rows = await rowsOf(batch.id);
    expect(rows.map((row) => row.outcome)).toEqual(NAMES.map(() => 'CREATED'));
    expect(await trailCount('people_import.confirmed', batch.id)).toBe(1);
    expect(await trailCount('people_import.completed', batch.id)).toBe(1);
  });
});

/** Relógio depois do fim da reserva (EX9): 5 min mais 1 s. */
const afterReservation = () =>
  vi.setSystemTime(new Date(NOW.getTime() + 5 * 60_000 + 1000));

/**
 * Um escritor que morre: reserva a próxima linha e, com `created`, chama o
 * `RowWriter` real (a pessoa nasce); nunca chama `finalizeRow`.
 */
async function deadWriter(input: {
  batch: BatchSummary;
  actor: string;
  token: string;
  created: boolean;
}): Promise<ReservedRow> {
  const { writeRepo, rowWriter, repo } = e2e();
  const reserved = await writeRepo.reserveNextRow({
    batchId: input.batch.id,
    now: new Date(),
    token: input.token,
  });
  if (reserved === null) throw new Error('nenhuma linha para reservar');
  if (input.created) {
    await rowWriter.write({
      plan: reserved.plan,
      personId: reserved.personId,
      actor: await loadImportActor(db(), input.actor),
      reason: importReason(input.batch.fileName),
      catalog: await repo.loadCatalog(),
    });
  }
  return reserved;
}

const outcomesOf = async (batchId: string) =>
  (await rowsOf(batchId)).map((row) => row.outcome);

describe.skipIf(!TESTCONTAINERS_ENABLED)('aceite 25', () => {
  const NAMES = namesOf('Interrompida', 3);

  it('aceite 25: gravação interrompida e continuada não grava duas vezes a mesma linha', async () => {
    const batch = await uploadCsv(ids.admin, adminRows(NAMES, 'I25'));
    await confirmAll(ids.admin, batch.id);
    // a linha 2 morreu depois de criar a pessoa; a linha 3, antes de criar
    const wrote = await deadWriter({
      batch,
      actor: ids.admin,
      token: 'a',
      created: true,
    });
    await deadWriter({ batch, actor: ids.admin, token: 'b', created: false });

    const meanwhile = await e2e().writer.writeBlock(ids.admin, batch.id);

    // reserva viva: o bloco grava só a linha livre e o lote segue em andamento
    expect(meanwhile.situation).toBe('WRITING');
    expect(await namesIn(NAMES)).toEqual([NAMES[0], NAMES[2]]);
    afterReservation();
    const done = await writeAll(ids.admin, batch.id);

    expect(done.situation).toBe('COMPLETED');
    expect(await namesIn(NAMES)).toEqual(NAMES);
    expect(await outcomesOf(batch.id)).toEqual([
      'UNCHANGED',
      'CREATED',
      'CREATED',
    ]);
    expect((await rowsOf(batch.id))[0].personId).toBe(wrote.personId);
    expect(await trailCount('people_import.completed', batch.id)).toBe(1);
  });
});

describe.skipIf(!TESTCONTAINERS_ENABLED)('aceite 25 (R4)', () => {
  const NAMES = namesOf('Retomada', 3);
  const rowsWithoutRegistration = (): ImportRow[] =>
    NAMES.map((nome) => ({
      nome,
      telefone: phoneCell(nextPhone()),
      setor: 'Logística',
    }));

  it('aceite 25 sem telefone.ver_completo e sem matrícula: retomada depois de criar dá Sem alteração', async () => {
    const batch = await uploadCsv(ids.blind, rowsWithoutRegistration());
    await confirmAll(ids.blind, batch.id);
    const wrote = await deadWriter({
      batch,
      actor: ids.blind,
      token: 'r4',
      created: true,
    });
    expect(await namesIn(NAMES)).toEqual([NAMES[0]]);

    afterReservation();
    const done = await writeAll(ids.blind, batch.id);

    expect(done.situation).toBe('COMPLETED');
    expect(await namesIn(NAMES)).toEqual(NAMES);
    const rows = await rowsOf(batch.id);
    expect(rows.map((row) => row.outcome)).toEqual([
      'UNCHANGED',
      'CREATED',
      'CREATED',
    ]);
    expect(rows[0].personId).toBe(wrote.personId);
    expect(rows.some((row) => row.outcome === 'FAILED')).toBe(false);
  });
});

describe.skipIf(!TESTCONTAINERS_ENABLED)('S1-7 (aceite 24)', () => {
  const NAMES = namesOf('Sigilo', 2);

  it('S1-7 (aceite 24): sem a chave, dois envios que diferem só por o número existir dão prévias iguais', async () => {
    const phones = [nextPhone(), nextPhone()];
    const file: ImportRow[] = NAMES.map((nome, index) => ({
      nome,
      telefone: phoneCell(phones[index]),
      setor: 'Logística',
    }));
    const first = await uploadCsv(ids.blind, file);
    const firstRows = await firstPage(ids.blind, first.id);

    await personWith('Dono do Número', {
      phone: phones[0],
      sectorId: ids.logistics,
    });
    const second = await uploadCsv(ids.blind, file);
    const secondRows = await firstPage(ids.blind, second.id);

    const shown = (batch: BatchSummary) => ({
      counts: batch.counts,
      phoneCheckDeferred: batch.phoneCheckDeferred,
    });
    expect(first.counts).toMatchObject({ CREATE: 2 });
    expect(shown(second)).toStrictEqual(shown(first));
    expect(secondRows).toStrictEqual(firstRows);
    // quem tem a chave enxerga a diferença: um dos números já é de alguém
    const withKey = await uploadCsv(ids.admin, file);
    expect(withKey.counts?.CREATE).toBe(1);
  });
});
