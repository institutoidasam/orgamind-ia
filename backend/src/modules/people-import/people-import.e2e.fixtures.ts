import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { vi } from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import type {
  BatchSummary,
  ConfirmBody,
} from '../../schemas/contracts/people-import.schema';
import { AuditRepository } from '../../shared/audit/audit.repository';
import { AuditService } from '../../shared/audit/audit.service';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { formatPhoneCell } from '../../shared/spreadsheet/cell-rules';
import { readCsvSheet } from '../../shared/spreadsheet/csv-reader';
import type { DownloadSink } from '../../shared/spreadsheet/download';
import { PEOPLE_TEMPLATE_COLUMNS } from '../../shared/spreadsheet/people-columns';
import type { SheetData } from '../../shared/spreadsheet/sheet-data';
import {
  openSpreadsheet,
  type SpreadsheetFormat,
} from '../../shared/spreadsheet/spreadsheet-writer';
import type { RefreshService } from '../auth/refresh.service';
import { ContactsRepository } from '../contacts/contacts.repository';
import type { ContactsService } from '../contacts/contacts.service';
import { ContactPhoneConflictError } from '../contacts/errors/contacts.errors';
import { UserPhoneService } from '../users/user-phone.service';
import { UsersRepository } from '../users/users.repository';
import {
  type PersonWithoutAccessInput,
  UsersService,
} from '../users/users.service';
import { BatchClassifier } from './batch-classifier';
import { PeopleImportCloseRepository } from './people-import-close.repository';
import { PeopleImportConfirmService } from './people-import-confirm.service';
import { PeopleImportFilesService } from './people-import-files.service';
import { PeopleImportPreviewService } from './people-import-preview.service';
import { PeopleImportQueryService } from './people-import-query.service';
import { PeopleImportWriteRepository } from './people-import-write.repository';
import { PeopleImportWriterService } from './people-import-writer.service';
import { PeopleImportRepository } from './people-import.repository';
import { RowWriter } from './row-writer';

// Ponta a ponta da importação de pessoas (Lote E): Postgres real com as
// migrações, os serviços reais montados à mão (sem o módulo do Nest) e os
// passos que os testes repetem: enviar, confirmar, gravar e ler o relatório.
// Relógio em Manaus (UTC-4): a pessoa "antiga" nasce ontem e o teste roda hoje.

export const YESTERDAY = new Date('2026-11-18T15:00:00Z');
export const NOW = new Date('2026-11-19T15:00:00Z');
export const TODAY = '2026-11-19';
export const TESTCONTAINERS_ENABLED =
  process.env.TESTCONTAINERS_ENABLED === '1';

const SHEET_NAME = 'Pessoas';
/** Teto de blocos de gravação por lote nos testes: um lote pequeno acaba no primeiro. */
const MAX_BLOCKS = 50;

/**
 * Quem usa a importação. `manager` (SUPERVISOR) gerencia Operação e tem
 * `telefone.ver_completo`; `blind` (OPERATOR) gerencia Logística e não tem a
 * chave: os dois têm `pessoas.importar` e `pessoas.editar` (papéis diferentes
 * porque a matriz de permissões é por papel). RH não tem gestor.
 */
export type E2EIds = {
  admin: string;
  manager: string;
  blind: string;
  operation: string;
  logistics: string;
  hr: string;
  night: string;
  morning: string;
  employee: string;
  leader: string;
};

export type ImportE2E = {
  prisma: PrismaClient;
  ids: E2EIds;
  users: UsersService;
  repo: PeopleImportRepository;
  writeRepo: PeopleImportWriteRepository;
  rowWriter: RowWriter;
  query: PeopleImportQueryService;
  preview: PeopleImportPreviewService;
  confirm: PeopleImportConfirmService;
  writer: PeopleImportWriterService;
  files: PeopleImportFilesService;
};

/** Uma linha do arquivo por nome de coluna; coluna fora do modelo vira coluna extra. */
export type ImportRow = Readonly<Record<string, string>>;

type Stored = { postgres: StartedPostgreSqlContainer; e2e: ImportE2E };
let stored: Stored | null = null;
let sequence = 0;

export function e2e(): ImportE2E {
  if (stored === null) throw new Error('setupImportE2E() não foi chamado');
  return stored.e2e;
}

/** Telefone celular de Manaus, fictício e único no processo (E.164). */
export function nextPhone(): string {
  sequence += 1;
  return `+5592991${String(sequence).padStart(6, '0')}`;
}

/** O telefone como a planilha o traz: começa por "(", nunca por "+" (fórmula). */
export function phoneCell(phoneE164: string): string {
  return formatPhoneCell(phoneE164);
}

/** Contatos sobre o banco do teste; a corrida no telefone vira o erro do serviço real. */
function contactsOn(prisma: PrismaClient): ContactsService {
  return {
    create: async (data: { phone: string; name: string }) => {
      try {
        return await prisma.contact.create({
          data: { name: data.name, phoneE164: data.phone },
        });
      } catch (error) {
        const race =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002';
        throw race ? new ContactPhoneConflictError(data.phone) : error;
      }
    },
    update: (id: string, data: { name: string }) =>
      prisma.contact.update({ where: { id }, data }),
  } as unknown as ContactsService;
}

/** Os serviços reais do módulo; as dependências por propriedade vão à mão (como o Nest faria). */
function buildServices(
  prisma: PrismaClient,
): Omit<ImportE2E, 'ids' | 'prisma'> {
  const db = prisma as unknown as PrismaService;
  const audit = new AuditService(new AuditRepository(db), {
    get: () => undefined,
  } as never);
  const usersRepo = new UsersRepository(db);
  const phones = new UserPhoneService(
    usersRepo,
    contactsOn(prisma),
    new ContactsRepository(db),
  );
  const refresh = { revokeAllForUser: vi.fn() } as unknown as RefreshService;
  const users = new UsersService(usersRepo, audit, refresh, phones);
  const repo = new PeopleImportRepository(db);
  const writeRepo = new PeopleImportWriteRepository(db);
  const closeRepo = new PeopleImportCloseRepository(db);
  const rowWriter = new RowWriter(repo, users);
  const query = new PeopleImportQueryService(db, repo, closeRepo);
  const confirm = new PeopleImportConfirmService(
    db,
    query,
    writeRepo,
    closeRepo,
  );
  const classifier = new BatchClassifier(repo);
  const preview = new PeopleImportPreviewService(db, repo, classifier, query);
  const writer = new PeopleImportWriterService(db, query, writeRepo, rowWriter);
  const files = new PeopleImportFilesService(db, repo, closeRepo, query);
  Object.assign(confirm, { audit });
  Object.assign(preview, { confirmService: confirm });
  Object.assign(writer, { repo, confirmService: confirm });
  return {
    users,
    repo,
    writeRepo,
    rowWriter,
    query,
    preview,
    confirm,
    writer,
    files,
  };
}

/**
 * ADMIN, os dois gestores e a matriz de permissões deles (a da migração nega `pessoas.importar`).
 * `createdAt` vem do relógio real (o `Date` falso não chega ao banco): nasce ontem, como
 * as pessoas de `createPerson`, para a exportação (que corta por `createdAt`) as incluir em qualquer dia.
 */
async function seedPeople(prisma: PrismaClient) {
  const user = (role: 'ADMIN' | 'SUPERVISOR' | 'OPERATOR', email: string) =>
    prisma.user.create({
      data: { name: role, email, password: 'x', role, createdAt: YESTERDAY },
    });
  const [admin, manager, blind] = await Promise.all([
    user('ADMIN', 'adm@test.local'),
    user('SUPERVISOR', 'gestor@test.local'),
    user('OPERATOR', 'gestor-cego@test.local'),
  ]);
  const grant = (role: 'SUPERVISOR' | 'OPERATOR', key: string, on = true) =>
    prisma.rolePermission.upsert({
      where: { role_key: { role, key } },
      create: { role, key, granted: on },
      update: { granted: on },
    });
  await grant('SUPERVISOR', 'pessoas.importar');
  await grant('OPERATOR', 'pessoas.importar');
  await grant('OPERATOR', 'telefone.ver_completo', false);
  return { admin: admin.id, manager: manager.id, blind: blind.id };
}

/** Setores, turnos e (da migração) os níveis `level_employee` e `level_leader`. */
async function seedStructure(prisma: PrismaClient, people: Partial<E2EIds>) {
  const sector = async (name: string, code: string, managerId?: string) =>
    (await prisma.sector.create({ data: { name, code, managerId } })).id;
  const shift = async (name: string, startTime: string, sortOrder: number) =>
    (
      await prisma.shift.create({
        data: { name, startTime, endTime: '15:00', sortOrder },
      })
    ).id;
  return {
    operation: await sector('Operação', 'OPE', people.manager),
    logistics: await sector('Logística', 'LOG', people.blind),
    hr: await sector('RH', 'RH'),
    night: await shift('Noite', '19:00', 98),
    morning: await shift('Manhã', '07:00', 99),
    employee: 'level_employee',
    leader: 'level_leader',
  };
}

/** Sobe o Postgres, aplica as migrações, semeia e monta os serviços. */
export async function setupImportE2E(): Promise<ImportE2E> {
  const postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('database_test')
    .withUsername(`user_${randomUUID().replaceAll('-', '')}`)
    .withPassword(randomUUID())
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const people = await seedPeople(prisma);
  const ids = { ...people, ...(await seedStructure(prisma, people)) };
  stored = { postgres, e2e: { prisma, ids, ...buildServices(prisma) } };
  return stored.e2e;
}

export async function stopImportE2E(): Promise<void> {
  await stored?.e2e.prisma.$disconnect();
  await stored?.postgres.stop();
  stored = null;
}

/** Só o `Date` é falso: hoje é 19/11 em Manaus; timers e I/O seguem reais (GX4). */
export function useE2EClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
}

/**
 * Pessoa sem acesso pelo cadastro manual, no dia `bornAt` (ontem), em Operação por padrão.
 * O `Date` falso só alcança o código do serviço (vínculo, trilha); o `createdAt` da pessoa
 * vem do relógio real do banco. Como a exportação corta por `createdAt` contra o "hoje" do
 * relógio falso, ele é gravado em `bornAt`: sem isso o teste dependeria do dia em que roda.
 */
export async function createPerson(
  change: Partial<PersonWithoutAccessInput> = {},
  bornAt: Date = YESTERDAY,
): Promise<{ id: string; phone: string }> {
  const { users, ids, prisma } = e2e();
  const phone = change.phone ?? nextPhone();
  vi.setSystemTime(bornAt);
  const created = await users.createPersonWithoutAccess(ids.admin, {
    name: `Pessoa ${sequence}`,
    sectorId: ids.operation,
    ...change,
    phone,
  });
  vi.setSystemTime(NOW);
  await prisma.user.update({
    where: { id: created.id },
    data: { createdAt: bornAt },
  });
  return { id: created.id, phone };
}

/** Destino de download em memória (`PassThrough` com os três campos do `res` do Express). */
export function memorySink() {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const bytes = new Promise<Buffer>((resolve, reject) => {
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
  const setHeader = vi.fn();
  const removeHeader = vi.fn();
  const sink = Object.assign(stream, {
    setHeader,
    removeHeader,
    headersSent: false,
  }) as DownloadSink;
  return { sink, bytes, setHeader, removeHeader };
}

/** Colunas do modelo (sempre as 11) e, depois, as extras que as linhas trazem. */
function columnsOf(rows: readonly ImportRow[]): string[] {
  const known = new Set<string>(PEOPLE_TEMPLATE_COLUMNS);
  const extras = new Set<string>();
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!known.has(column)) extras.add(column);
    }
  }
  return [...PEOPLE_TEMPLATE_COLUMNS, ...extras];
}

/** O arquivo em memória, escrito pelos escritores do Lote D (CSV com BOM e `;`, ou XLSX). */
export async function sheetBuffer(
  format: SpreadsheetFormat,
  rows: readonly ImportRow[],
): Promise<Buffer> {
  const { sink, bytes } = memorySink();
  const writer = openSpreadsheet({ sink, format, firstSheet: SHEET_NAME });
  const columns = columnsOf(rows);
  await writer.writeRow(columns);
  for (const row of rows) {
    await writer.writeRow(columns.map((column) => row[column] ?? ''));
  }
  await writer.close();
  return bytes;
}

/** Envia o arquivo como o controller faria e devolve o resumo da prévia. */
export async function uploadSheet(
  actor: string,
  rows: readonly ImportRow[],
  file: { format: SpreadsheetFormat; name: string },
): Promise<BatchSummary> {
  const buffer = await sheetBuffer(file.format, rows);
  return e2e().preview.upload(actor, {
    originalName: file.name,
    size: buffer.length,
    buffer,
  });
}

export function uploadCsv(
  actor: string,
  rows: readonly ImportRow[],
  name = 'equipe.csv',
): Promise<BatchSummary> {
  return uploadSheet(actor, rows, { format: 'csv', name });
}

const ALL = { createNew: true, updateExisting: true, excludedRows: [] };

/**
 * Confirma criar e atualizar, sem excluir linha, com o mapeamento que a tela
 * mostraria: o do resumo do lote lido agora (EX7).
 */
export async function confirmAll(
  actor: string,
  batchId: string,
  body: Partial<ConfirmBody> = {},
): Promise<BatchSummary> {
  const { mapping } = await e2e().query.summary(actor, batchId);
  return e2e().confirm.confirm(actor, batchId, { ...ALL, mapping, ...body });
}

/** Pede blocos de gravação até o lote sair de "Gravando"; devolve o último resumo. */
export async function writeAll(
  actor: string,
  batchId: string,
): Promise<BatchSummary> {
  for (let block = 0; block < MAX_BLOCKS; block += 1) {
    const summary = await e2e().writer.writeBlock(actor, batchId);
    if (summary.situation !== 'WRITING') return summary;
  }
  throw new Error('a gravação não terminou nos blocos esperados');
}

/** O `errors.csv` do lote, lido pelo serviço real e relido pelo leitor de CSV do Lote E. */
export async function readErrorReport(
  actor: string,
  batchId: string,
): Promise<SheetData> {
  const { sink, bytes } = memorySink();
  await e2e().files.errorReport(actor, batchId, sink);
  return readCsvSheet(await bytes);
}
