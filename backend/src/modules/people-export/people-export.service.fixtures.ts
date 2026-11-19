import { PassThrough } from 'node:stream';
import type { Role } from '@prisma/client';
import { expect, vi } from 'vitest';
import type { AuditService } from '../../shared/audit/audit.service';
import {
  actorWith,
  type PermissionChange,
} from '../../shared/authz/actor.test-fixtures';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { DownloadSink } from '../../shared/spreadsheet/download';
import type { CivilDate } from '../staff-schedule/civil-date';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import type { AssignmentLine } from '../users/assignment-timeline';
import type { DomainError } from '../../shared/errors/domain.error';
import type {
  CandidateFilter,
  PeopleExportRepository,
} from './people-export.repository';
import { PeopleExportService } from './people-export.service';
import type {
  ExportNameMaps,
  PeopleCandidateRow,
  PeopleDetailRow,
} from './people-rows';

export const PHONE_NAME = '92 99111-2008';
export const MASKED = '•••• 2008';

export const NAMES: ExportNameMaps = {
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

type ActorOptions = PermissionChange & {
  managedSectorIds?: readonly string[];
  isActive?: boolean;
  hasAccess?: boolean;
};

/** Ator do `findTeamActor`: o papel com as permissões do padrão, mais ajustes. */
export function teamActor(role: Role, options: ActorOptions = {}): TeamActor {
  const { managedSectorIds = [], isActive, hasAccess, ...change } = options;
  return {
    ...actorWith(role, change),
    isActive: isActive ?? true,
    hasAccess: hasAccess ?? true,
    managedSectorIds,
  };
}

export function candidate(
  over: Partial<PeopleCandidateRow> = {},
): PeopleCandidateRow {
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

export function detail(over: Partial<PeopleDetailRow> = {}): PeopleDetailRow {
  return {
    id: 'p1',
    registration: 'M-100',
    name: 'Ana Souza',
    phoneE164: '+5592991112008',
    jobTitle: 'Analista',
    contactAuthorization: 'AUTORIZADO',
    authorizationSource: null,
    authorizationNote: null,
    authorizationDate: null,
    isActive: true,
    hasAccess: false,
    ...over,
  };
}

export type FakeRepoData = {
  candidates?: readonly PeopleCandidateRow[];
  lines?: Readonly<Record<string, readonly AssignmentLine[]>>;
  details?: readonly PeopleDetailRow[];
  names?: ExportNameMaps;
};

function covers(line: AssignmentLine, date: CivilDate): boolean {
  return (
    (line.from === null || line.from <= date) &&
    (line.to === null || line.to >= date)
  );
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : 1;
}

/**
 * Repositório em memória: `pageCandidates` pagina por cursor de `id` SEM aplicar o
 * filtro (o SQL é só redução; o teste lê o `CandidateFilter` recebido e a função
 * pura da T6 confere o recorte). Cada método é `vi.fn` para contar chamadas.
 */
export function fakeRepo(data: FakeRepoData = {}) {
  const sorted = [...(data.candidates ?? [])].sort(byId);
  const lines = data.lines ?? {};
  const details = data.details ?? [];
  const mocks = {
    pageCandidates: vi.fn(
      (_filter: CandidateFilter, take: number, afterId?: string) =>
        Promise.resolve(
          sorted
            .filter((row) => afterId === undefined || row.id > afterId)
            .slice(0, take),
        ),
    ),
    linesOn: vi.fn((ids: readonly string[], date: CivilDate) => {
      const found = ids
        .map((id): [string, AssignmentLine[]] => [
          id,
          (lines[id] ?? []).filter((line) => covers(line, date)),
        ])
        .filter(([, own]) => own.length > 0);
      return Promise.resolve(new Map(found));
    }),
    detailsByIds: vi.fn((ids: readonly string[]) =>
      Promise.resolve(details.filter((row) => ids.includes(row.id))),
    ),
    nameMaps: vi.fn(() => Promise.resolve(data.names ?? NAMES)),
  };
  return { ...mocks, repo: mocks as unknown as PeopleExportRepository };
}

/** O `CandidateFilter` da primeira página lida. */
export function firstFilter(
  repo: ReturnType<typeof fakeRepo>,
): CandidateFilter {
  return repo.pageCandidates.mock.calls[0][0];
}

/** O erro lançado é `expected`: mesmo código, status e texto para a tela. */
export async function expectDomainError(
  promise: Promise<unknown>,
  expected: DomainError,
): Promise<void> {
  const caught = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught).toMatchObject({
    code: expected.code,
    status: expected.status,
    detail: expected.detail,
  });
}

/** O cliente de transação que o `$transaction` falso entrega ao callback. */
export const TX = { fake: 'tx' };

/**
 * Destino de download em memória: um `PassThrough` com os campos do `res` do
 * Express. `headersSent` vira verdadeiro na primeira escrita, como no Express.
 * `probe` diz se a transação da trilha já fechou: cada header e cada escrita
 * guarda o que viu.
 */
export function makeSink(probe: () => boolean = () => true) {
  const headerSeen: boolean[] = [];
  const writeSeen: boolean[] = [];
  const setHeader = vi.fn(() => {
    headerSeen.push(probe());
  });
  const removeHeader = vi.fn();
  const stream = new PassThrough({
    transform(chunk: Buffer, _encoding, done) {
      writeSeen.push(probe());
      Object.assign(this, { headersSent: true });
      done(null, chunk);
    },
  });
  const sink = Object.assign(stream, {
    setHeader,
    removeHeader,
    headersSent: false,
  });
  const chunks: Buffer[] = [];
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<Buffer>((resolve) =>
    sink.on('end', () => resolve(Buffer.concat(chunks))),
  );
  return {
    sink: sink as DownloadSink,
    write: vi.spyOn(sink, 'write'),
    setHeader,
    removeHeader,
    headerSeen,
    writeSeen,
    chunks,
    ended,
  };
}

export type ExportKitSetup = { data?: FakeRepoData; trailError?: Error };

/**
 * Serviço de exportação com repositório em memória, `$transaction` que só
 * marca a transação como fechada depois do callback e `recordChange` espionado.
 */
export function exportKit(setup: ExportKitSetup = {}) {
  const repo = fakeRepo(setup.data);
  const tx = { closed: false };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: object) => Promise<void>) => {
      await fn(TX);
      tx.closed = true;
    }),
  };
  const audit = {
    recordChange: vi.fn<(tx: unknown, change: unknown) => Promise<void>>(() =>
      setup.trailError ? Promise.reject(setup.trailError) : Promise.resolve(),
    ),
  };
  const service = new PeopleExportService(
    prisma as unknown as PrismaService,
    repo.repo,
    audit as unknown as AuditService,
  );
  return { service, repo, prisma, audit, ...makeSink(() => tx.closed) };
}
