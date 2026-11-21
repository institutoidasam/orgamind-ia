import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import { TeamAlertAckService } from './team-alert-ack.service';
import {
  T0,
  at,
  grantPermission,
  newAlert,
  newPendency,
  newSector,
  newTeamUser,
  revokePermission,
  startPendencyDb,
  stopPendencyDb,
  type PendencyDb as TestDb,
} from './team-pendency.test-fixtures';
import { TeamWhatsappRepository } from './team-whatsapp.repository';

/**
 * Aceite 21 (K2-7, DK17): ciência manual e desfazer pela pendência no alcance,
 * com o `TeamAlertAckService` real contra o Postgres. Opt-in (Testcontainers):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-alert-ack.scope.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const NOTE = 'confirmou por ligação';

let db: TestDb;
let ack: TeamAlertAckService;
const audit = { log: vi.fn().mockResolvedValue(undefined) };

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  const prisma = db.prisma as unknown as PrismaService;
  const repo = new TeamWhatsappRepository(
    prisma,
    new StaffScheduleRepository(prisma),
  );
  ack = new TeamAlertAckService(repo, prisma, audit as never);
  // SUPERVISOR com a chave; OPERATOR sem ela (a matriz padrão não a dá a nenhum).
  await grantPermission(db, 'SUPERVISOR', 'equipe.urgencia');
  await revokePermission(db, 'OPERATOR', 'equipe.urgencia');
}, 180_000);

afterAll(async () => {
  if (ENABLED) await stopPendencyDb(db);
});

beforeEach(() => {
  audit.log.mockClear();
});

const mark = (actorId: string, d: string, r: string) =>
  ack.markManual(actorId, d, r, { note: NOTE, now: at(5) });

const ackOf = (id: string) =>
  db.prisma.teamWhatsappRecipient.findUniqueOrThrow({
    where: { id },
    select: { ackAt: true, ackKind: true, ackByUserId: true, ackNote: true },
  });

/** Alerta do ADMIN com uma pendência no setor novo do gestor (que não vê o envio). */
async function managedPendency(role: 'SUPERVISOR' | 'OPERATOR' = 'SUPERVISOR') {
  const manager = await newTeamUser(db, { role });
  const sector = await newSector(db, { managerId: manager.id });
  const dispatchId = await newAlert(db, {
    authorId: db.ids.admin,
    createdAt: T0,
  });
  const recipientId = await newPendency(db, {
    dispatchId,
    sectorId: sector.id,
  });
  return { managerId: manager.id, d: dispatchId, r: recipientId };
}

const NOT_FOUND = { status: 404, code: 'team_whatsapp.dispatch_not_found' };

/** Cada operação em thunk: só roda quando o teste a espera (sem rejeição solta). */
type Ops = ReadonlyArray<() => Promise<unknown>>;

const bothOps = (actorId: string, d: string, r: string): Ops => [
  () => mark(actorId, d, r),
  () => ack.undoManual(actorId, d, r),
];

async function expectAll(ops: Ops, expected: object): Promise<void> {
  for (const op of ops) await expect(op()).rejects.toMatchObject(expected);
}

async function registersAndUndoes(): Promise<void> {
  const { managerId, d, r } = await managedPendency();
  await mark(managerId, d, r);
  expect(await ackOf(r)).toEqual({
    ackAt: at(5),
    ackKind: 'MANUAL',
    ackByUserId: managerId,
    ackNote: NOTE,
  });
  await ack.undoManual(managerId, d, r);
  expect(await ackOf(r)).toEqual({
    ackAt: null,
    ackKind: null,
    ackByUserId: null,
    ackNote: null,
  });
  const events = audit.log.mock.calls.map((call) => String(call[0]));
  expect(events).toEqual([
    'team_whatsapp.ack_manual',
    'team_whatsapp.ack_manual_undo',
  ]);
}

async function keepsRefusalOrder(): Promise<void> {
  const mine = await managedPendency();
  const foreign = await managedPendency();
  const noKey = await managedPendency('OPERATOR');
  // 403 da chave antes de qualquer leitura do envio (a pendência é de outro gestor).
  await expectAll(bothOps(noKey.managerId, foreign.d, foreign.r), {
    status: 403,
    code: 'auth.permission_denied',
  });
  // Com a chave, fora do alcance: o mesmo 404 de envio inexistente.
  await expectAll(bothOps(mine.managerId, foreign.d, foreign.r), NOT_FOUND);
  // No alcance, com ciência automática: 422 (marcar: ack_exists; desfazer: ack_not_manual).
  await db.prisma.teamWhatsappRecipient.update({
    where: { id: mine.r },
    data: { ackAt: at(2), ackKind: 'KEYWORD' },
  });
  const [markOp, undoOp] = bothOps(mine.managerId, mine.d, mine.r);
  await expect(markOp()).rejects.toMatchObject({
    status: 422,
    code: 'team_whatsapp.ack_exists',
  });
  await expect(undoOp()).rejects.toMatchObject({
    status: 422,
    code: 'team_whatsapp.ack_not_manual',
  });
}

async function keepsClosureColumns(): Promise<void> {
  const { managerId, d, r } = await managedPendency();
  const closure = {
    pendencyHandlerId: managerId,
    pendencyClosedAt: at(3),
    pendencyClosedById: db.ids.admin,
    pendencyCloseReason: 'Resolvido por telefone',
  };
  await db.prisma.teamWhatsappRecipient.update({
    where: { id: r },
    data: closure,
  });
  await mark(managerId, d, r);
  const row = await db.prisma.teamWhatsappRecipient.findUniqueOrThrow({
    where: { id: r },
    select: {
      ackKind: true,
      pendencyHandlerId: true,
      pendencyClosedAt: true,
      pendencyClosedById: true,
      pendencyCloseReason: true,
    },
  });
  expect(row).toEqual({ ackKind: 'MANUAL', ...closure });
}

describe.skipIf(!ENABLED)('ciência manual pela pendência — aceite 21', () => {
  it(
    'aceite 21: SUPERVISOR com equipe.urgencia que vê a pendência, sem ver o envio — registra e desfaz a ciência manual',
    registersAndUndoes,
  );
  it(
    'aceite 21: ordem 403 → 404 → 422 inalterada — sem equipe.urgencia e fora do alcance: 403 da chave; fora do alcance: 404; no alcance com ciência: 422 ack_exists',
    keepsRefusalOrder,
  );
  it(
    'ciência manual numa pendência encerrada — registra; colunas de encerramento intactas',
    keepsClosureColumns,
  );
});
