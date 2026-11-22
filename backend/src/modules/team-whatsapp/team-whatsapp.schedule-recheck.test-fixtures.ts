import { vi, type Mock } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { PrismaClient, type Prisma } from '@prisma/client';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import type { Env } from '../../shared/config/env.schema';
import { ConsentService } from '../consent/consent.service';
import { LevelsRepository } from '../levels/levels.repository';
import type { TeamWhatsappSendJob } from '../queue/queue.constants';
import {
  addDays,
  todayIn,
  toDbDate,
  type CivilDate,
} from '../staff-schedule/civil-date';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import type { TeamAudienceRequest } from './dto/create-team-dispatch.dto';
import { TeamAudienceService } from './team-audience.service';
import { TeamWhatsappScheduleService } from './team-whatsapp-schedule.service';
import { TeamWhatsappRepository } from './team-whatsapp.repository';
import { TeamWhatsappService } from './team-whatsapp.service';

/**
 * Dublês e sementes do disparo agendado contra Postgres real (Lote G: T6b, e
 * reusados pela T10a/T10b só importando). Serviços e repositório são os de
 * verdade; fila, auditoria e estado ao vivo do número são dublês (nunca envia).
 * Não é spec: não roda sozinho.
 */

const SECRET = 'segredo-de-teste-do-agendado-0123456789-abcdef';
const config = {
  get: (key: string) => (key === 'JWT_SECRET' ? SECRET : undefined),
} as unknown as ConfigService<Env>;

/** Data de referência: três dias à frente do relógio real, que o envio exige no futuro. */
export const REFERENCE_DATE: CivilDate = addDays(todayIn(new Date()), 3);
/** Turno semeado pelas migrações (o 1º turno). */
export const FIRST_SHIFT = 'shift_first';
export const MINUTE = 60_000;

export type BulkJob = {
  name: string;
  data: TeamWhatsappSendJob;
  opts: { jobId: string };
};

export type RecheckDeps = {
  prisma: PrismaClient;
  repo: TeamWhatsappRepository;
  audience: TeamAudienceService;
  service: TeamWhatsappService;
  schedule: TeamWhatsappScheduleService;
  queue: { addBulk: Mock<(jobs: BulkJob[]) => Promise<unknown>> };
  audit: { log: Mock };
};

/** Estado ao vivo falso: todo número aberto (só o envio "agora" consulta). */
const live = {
  checkMany: vi.fn((channels: readonly { id: string }[]) =>
    Promise.resolve(
      new Map(
        channels.map((c) => [
          c.id,
          { channelId: c.id, state: 'open', checkedAt: new Date() },
        ]),
      ),
    ),
  ),
};

/** Sobe um Postgres, aplica as migrações e monta os serviços de verdade. */
export async function startRecheckDeps(): Promise<{
  deps: RecheckDeps;
  stop: () => Promise<void>;
}> {
  const postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const repo = new TeamWhatsappRepository(
    prisma as never,
    new StaffScheduleRepository(prisma as never),
  );
  const consent = new ConsentService(prisma as never, config);
  const levels = new LevelsRepository(prisma as never);
  const audience = new TeamAudienceService(repo, consent, levels, config);
  const queue = { addBulk: vi.fn<(jobs: BulkJob[]) => Promise<unknown>>() };
  const audit = { log: vi.fn() };
  const service = new TeamWhatsappService(
    repo,
    consent,
    audit as never,
    queue as never,
  );
  // `levels`, `live` e `audience` são injetados por propriedade no Nest; aqui, à mão.
  Object.assign(service, { levels, live, audience });
  const schedule = new TeamWhatsappScheduleService(
    repo,
    audit as never,
    queue as never,
  );
  const deps = { prisma, repo, audience, service, schedule, queue, audit };
  const stop = async () => {
    await prisma.$disconnect();
    await postgres.stop();
  };
  return { deps, stop };
}

export type World = {
  code: string;
  sectorId: string;
  sectorName: string;
  adminId: string;
};

let seq = 0;
let phoneSeq = 0;
const nextPhone = () => `+559299222${String(++phoneSeq).padStart(4, '0')}`;

/** Um setor com número ativo (Evolution) e um ADMIN que envia; códigos únicos. */
export async function seedWorld({ prisma }: RecheckDeps): Promise<World> {
  const code = `T6B-${++seq}`;
  const channel = await prisma.channel.create({
    data: {
      name: `Canal ${code}`,
      provider: 'EVOLUTION',
      isActive: true,
      phoneE164: nextPhone(),
      evolutionInstanceName: code,
    },
  });
  const sectorName = `Setor ${code}`;
  const sector = await prisma.sector.create({
    data: { name: sectorName, code, channelId: channel.id },
  });
  const admin = await prisma.user.create({
    data: { email: `${code}-adm@test.local`, password: 'x', role: 'ADMIN' },
  });
  return { code, sectorId: sector.id, sectorName, adminId: admin.id };
}

export type PersonOver = Partial<
  Pick<
    Prisma.UserUncheckedCreateInput,
    'phoneE164' | 'contactAuthorization' | 'shiftId' | 'levelId'
  >
>;

/** Pessoa ativa do setor, no 1º turno, com telefone fictício e contato autorizado. */
export function seedPerson(
  { prisma }: RecheckDeps,
  world: World,
  name: string,
  over: PersonOver = {},
) {
  return prisma.user.create({
    data: {
      email: `${world.code}-${name.toLowerCase()}@test.local`,
      password: 'x',
      name,
      sectorId: world.sectorId,
      shiftId: FIRST_SHIFT,
      phoneE164: nextPhone(),
      contactAuthorization: 'AUTORIZADO',
      ...over,
    },
  });
}

/** Folga ou férias lançada para a data (escala da pessoa). */
export function addException(
  { prisma }: RecheckDeps,
  userId: string,
  kind: 'DAY_OFF' | 'VACATION',
  date: CivilDate = REFERENCE_DATE,
) {
  return prisma.staffScheduleException.create({
    data: {
      userId,
      kind,
      startDate: toDbDate(date),
      endDate: toDbDate(date),
    },
  });
}

/** Aviso de turno no 1º turno, em "data e hora" (08:00 da data de referência). */
export const noticeAt = (
  world: World,
  over: Partial<TeamAudienceRequest> = {},
): TeamAudienceRequest => ({
  purpose: 'shift_notice',
  text: 'Aviso de teste do turno',
  when: 'at',
  at: { date: REFERENCE_DATE, time: '08:00' },
  target: {
    type: 'sector',
    sectorIds: [world.sectorId],
    shiftIds: [FIRST_SHIFT],
    date: REFERENCE_DATE,
  },
  ...over,
});

export type ScheduleBody = { actorId: string; request: TeamAudienceRequest };
export type Scheduled = { dispatchId: string; scheduledFor: Date };

/**
 * Agenda pelo caminho da tela: prévia, e envio com a impressão que ela devolveu.
 * Lança se o envio não saiu agendado.
 */
export async function scheduleViaService(
  deps: RecheckDeps,
  { actorId, request }: ScheduleBody,
): Promise<Scheduled> {
  const preview = await deps.audience.preview(actorId, request);
  const sent = await deps.service.dispatch(actorId, {
    ...request,
    audienceKey: preview.audienceKey,
  });
  if (!sent.scheduledFor) throw new Error('O envio não saiu agendado');
  return {
    dispatchId: sent.dispatchId,
    scheduledFor: new Date(sent.scheduledFor),
  };
}

/** Um tick do worker no instante dado (o `now` do disparo; nunca o relógio). */
export const fireAt = (deps: RecheckDeps, date: Date) =>
  deps.schedule.fireDue(date);

export const minutesAfter = (date: Date, minutes: number) =>
  new Date(date.getTime() + minutes * MINUTE);

/** Ids que foram para a fila, em todas as chamadas do dublê. */
export const queuedIds = ({ queue }: RecheckDeps): string[] =>
  queue.addBulk.mock.calls.flatMap(([jobs]) =>
    jobs.map((job) => job.data.recipientId),
  );

/** Situação do envio e dos destinatários (pelo id), como o banco guarda. */
export async function storedOf({ prisma }: RecheckDeps, dispatchId: string) {
  return prisma.teamWhatsappDispatch.findUniqueOrThrow({
    where: { id: dispatchId },
    select: {
      state: true,
      firedAt: true,
      recheckedAt: true,
      schedulePolicy: true,
      audienceLateJoined: true,
      recipients: {
        select: { id: true, userId: true, status: true, skipReason: true },
        orderBy: { id: 'asc' },
      },
    },
  });
}
