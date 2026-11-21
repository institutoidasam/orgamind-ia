import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma, type Role } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import { TeamWhatsappResultsService } from './team-whatsapp-results.service';
import { TeamWhatsappRepository } from './team-whatsapp.repository';
import { TeamWhatsappService } from './team-whatsapp.service';

// Lote I, T14 (CI10, I3, I7, I8; aceites 14 e 20): prazo e lembrete no histórico e
// no detalhe, contra o Postgres real. `createdAt` explícito em Manaus (-04:00);
// nada depende do relógio. Nomes fictícios; nada é enviado (só leitura).
const T0 = new Date('2026-11-20T09:00:00-04:00');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const PAGE = { page: 1, pageSize: 50 };

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let service: TeamWhatsappService;
let results: TeamWhatsappResultsService;
let seq = 0;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const repo = new TeamWhatsappRepository(
    prisma as never,
    new StaffScheduleRepository(prisma as never),
  );
  // A listagem e o detalhe só leem: consentimento, trilha e fila não entram.
  service = new TeamWhatsappService(
    repo,
    {} as never,
    {} as never,
    {} as never,
  );
  results = new TeamWhatsappResultsService(repo);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

/** Usuário com login; o gestor (SUPERVISOR) recebe um setor ativo para poder enviar. */
async function user(role: Role): Promise<string> {
  const code = `hist-${++seq}`;
  const { id } = await prisma.user.create({
    data: {
      email: `${code}@test.local`,
      password: 'x',
      role,
      name: `Usuário ${code}`,
    },
  });
  if (role !== 'ADMIN') {
    await prisma.sector.create({
      data: { name: `Setor ${code}`, code, managerId: id },
    });
  }
  return id;
}

type DispatchOver = Partial<Prisma.TeamWhatsappDispatchUncheckedCreateInput>;

/** Envio a setor gravado direto: por padrão um alerta urgente de 15 min em T0. */
async function dispatch(authorId: string, over: DispatchOver = {}) {
  const { id } = await prisma.teamWhatsappDispatch.create({
    data: {
      authorId,
      targetType: 'SECTOR',
      targetId: 'setor-historico',
      targetLabel: 'Logística',
      text: 'Vazamento no galpão',
      purpose: 'URGENCY',
      urgencyReason: 'Vazamento',
      ackDeadlineMinutes: 15,
      createdAt: T0,
      ...over,
    },
    select: { id: true },
  });
  return id;
}

/** Lembrete do alerta: sem prazo próprio, ligado ao original, `min` minutos depois. */
const reminder = (alertId: string, authorId: string, min = 10) =>
  dispatch(authorId, {
    parentDispatchId: alertId,
    ackDeadlineMinutes: null,
    createdAt: at(min),
  });

const listItem = async (actorId: string, id: string) =>
  (await service.listDispatches(actorId, PAGE)).items.find((i) => i.id === id);

const NO_ALERT_FIELDS = {
  ackDeadlineMinutes: null,
  ackDeadlineAt: null,
  reminderOf: null,
};

describe('histórico do alerta e da urgência antiga (CI10)', () => {
  it('alerta: lista e detalhe com ackDeadlineMinutes 15 e ackDeadlineAt = createdAt + 15 min', async () => {
    const admin = await user('ADMIN');
    const id = await dispatch(admin);
    const expected = {
      ackDeadlineMinutes: 15,
      ackDeadlineAt: at(15).toISOString(),
      reminderOf: null,
    };
    expect(await listItem(admin, id)).toMatchObject(expected);
    expect(await results.detail(admin, id)).toMatchObject(expected);
  });

  it('aceite 14: urgência antiga e reunião — os três campos nulos', async () => {
    const admin = await user('ADMIN');
    const oldUrgency = await dispatch(admin, { ackDeadlineMinutes: null });
    const meeting = await dispatch(admin, {
      purpose: 'MEETING',
      urgencyReason: null,
      ackDeadlineMinutes: null,
    });
    for (const id of [oldUrgency, meeting]) {
      expect(await listItem(admin, id)).toMatchObject(NO_ALERT_FIELDS);
      expect(await results.detail(admin, id)).toMatchObject(NO_ALERT_FIELDS);
    }
  });
});

describe('histórico do lembrete (CI10, I7)', () => {
  it('lembrete: reminderOf com id e createdAt do alerta; ackDeadlineMinutes e ackDeadlineAt nulos', async () => {
    const admin = await user('ADMIN');
    const alertId = await dispatch(admin);
    const id = await reminder(alertId, admin);
    const expected = {
      ackDeadlineMinutes: null,
      ackDeadlineAt: null,
      reminderOf: { dispatchId: alertId, createdAt: T0.toISOString() },
    };
    expect(await listItem(admin, id)).toMatchObject(expected);
    expect(await results.detail(admin, id)).toMatchObject(expected);
  });

  it('aceite 20: detalhe do lembrete do ADMIN — 404 para o SUPERVISOR autor do alerta', async () => {
    const admin = await user('ADMIN');
    const supervisor = await user('SUPERVISOR');
    const alertId = await dispatch(supervisor);
    const id = await reminder(alertId, admin);
    await expect(results.detail(supervisor, id)).rejects.toMatchObject({
      status: 404,
    });
    expect(await listItem(supervisor, id)).toBeUndefined();
    expect((await results.detail(supervisor, alertId)).ackDeadlineMinutes).toBe(
      15,
    );
    expect((await results.detail(admin, id)).reminderOf?.dispatchId).toBe(
      alertId,
    );
  });

  it('detalhe do lembrete (audienceRule, audienceExcluded e roster nulos) responde sem erro', async () => {
    const admin = await user('ADMIN');
    const alertId = await dispatch(admin);
    const id = await reminder(alertId, admin);
    expect(await results.detail(admin, id)).toMatchObject({
      rule: null,
      excluded: [],
      leftOut: { unselected: [], off: [] },
    });
  });
});
