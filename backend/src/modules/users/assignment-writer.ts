import { Prisma } from '@prisma/client';
import {
  fromDbDate,
  toDbDate,
  type CivilDate,
} from '../staff-schedule/civil-date';
import {
  mergeAssignment,
  planAssignmentStep,
  sameAssignment,
  type AssignmentLine,
  type AssignmentPatch,
  type AssignmentStep,
  type AssignmentValues,
} from './assignment-timeline';

/**
 * Uma gravação de vínculo (DV5). `today` chega como dado (DV7): esta função
 * nunca lê o relógio para decidir a vigência. `origin` só muda o caso da
 * pessoa sem linha aberta: na criação abre hoje; na troca usa a linha que a
 * migração teria criado (DV8).
 */
export type AssignmentWrite = {
  userId: string;
  patch: AssignmentPatch;
  today: CivilDate;
  actorId: string | null;
  origin: 'CREATE' | 'CHANGE';
};

/** Único parcial da migração 20261119110000: no máximo uma linha aberta por pessoa. */
export const OPEN_ASSIGNMENT_INDEX = 'UserAssignment_userId_open_key';

const VALUES_SELECT = {
  sectorId: true,
  shiftId: true,
  levelId: true,
} as const;

type OpenLine = { id: string | null; line: AssignmentLine };

type StepContext = {
  tx: Prisma.TransactionClient;
  input: AssignmentWrite;
  mirror: AssignmentValues;
  openId: string | null;
};

async function readOpenLine(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<OpenLine | null> {
  const row = await tx.userAssignment.findFirst({
    where: { userId, validTo: null },
    select: { id: true, validFrom: true, ...VALUES_SELECT },
  });
  if (!row) return null;
  const { id, validFrom, ...values } = row;
  return {
    id,
    line: {
      ...values,
      from: validFrom ? fromDbDate(validFrom) : null,
      to: null,
    },
  };
}

/** DV8: pessoa sem linha, na troca, parte da linha migrada (início em branco). */
function currentLine(
  open: OpenLine | null,
  mirror: AssignmentValues,
  origin: AssignmentWrite['origin'],
): OpenLine | null {
  if (open || origin === 'CREATE') return open;
  return { id: null, line: { ...mirror, from: null, to: null } };
}

/** Id da linha aberta; sem linha gravada, grava a migrada (valores do espelho). */
async function openLineId(ctx: StepContext): Promise<string> {
  if (ctx.openId) return ctx.openId;
  const created = await ctx.tx.userAssignment.create({
    data: {
      userId: ctx.input.userId,
      ...ctx.mirror,
      validFrom: null,
      validTo: null,
      recordedById: null,
    },
    select: { id: true },
  });
  return created.id;
}

function insertOpenLine(
  ctx: StepContext,
  values: AssignmentValues,
  from: CivilDate,
): Promise<unknown> {
  return ctx.tx.userAssignment.create({
    data: {
      userId: ctx.input.userId,
      ...values,
      validFrom: toDbDate(from),
      validTo: null,
      recordedById: ctx.input.actorId,
    },
    select: { id: true },
  });
}

async function applyStep(
  ctx: StepContext,
  step: AssignmentStep,
): Promise<void> {
  if (step.kind === 'OPEN') await insertOpenLine(ctx, step.values, step.from);
  if (step.kind === 'UPDATE_OPEN') {
    await ctx.tx.userAssignment.update({
      where: { id: await openLineId(ctx) },
      data: {
        ...step.values,
        recordedById: ctx.input.actorId,
        recordedAt: new Date(),
      },
    });
  }
  if (step.kind === 'CLOSE_AND_OPEN') {
    // Fecha antes de abrir: o único parcial não aceita duas linhas abertas.
    await ctx.tx.userAssignment.update({
      where: { id: await openLineId(ctx) },
      data: { validTo: toDbDate(step.closeTo) },
    });
    await insertOpenLine(ctx, step.values, step.from);
  }
}

/**
 * Função única de escrita do vínculo (DV5, GV1): o único código que grava
 * `UserAssignment` e o espelho `User.sectorId/shiftId/levelId`. Roda dentro do
 * `tx` de quem chama (só `UsersRepository.createWithAudit` e
 * `updateWithLastAdminGuard`), antes da leitura do retrato que vai para a
 * trilha. Lê o espelho e a linha aberta, decide o passo pelas regras puras
 * (CV2), grava a(s) linha(s) e, se mudou, o espelho.
 */
export async function writeAssignment(
  tx: Prisma.TransactionClient,
  input: AssignmentWrite,
): Promise<AssignmentStep> {
  const mirror = await tx.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: VALUES_SELECT,
  });
  const open = await readOpenLine(tx, input.userId);
  const next = mergeAssignment(mirror, input.patch);
  const current = currentLine(open, mirror, input.origin);
  const step = planAssignmentStep(current?.line ?? null, next, input.today);
  await applyStep({ tx, input, mirror, openId: open?.id ?? null }, step);
  if (!sameAssignment(mirror, next)) {
    await tx.user.update({
      where: { id: input.userId },
      data: next,
      select: { id: true },
    });
  }
  return step;
}

/**
 * Inserção concorrente de linha aberta da mesma pessoa (DV7): o perdedor bate
 * no único parcial. Tratado como conflito de serialização: a nova tentativa
 * relê a linha aberta que o vencedor gravou.
 */
export function isOpenAssignmentConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  const target = error.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target)];
  return (
    fields.includes(OPEN_ASSIGNMENT_INDEX) ||
    (error.meta?.modelName === 'UserAssignment' &&
      fields.length === 1 &&
      fields[0] === 'userId')
  );
}
