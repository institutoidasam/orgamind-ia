import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import { TeamWhatsappRepository } from './team-whatsapp.repository';

// DH13 contra Postgres real: o claim do agendado grava `updatedAt` = `now` do
// disparo, e não a hora do relógio (o `@updatedAt` do Prisma), para o verificador
// de presos (idade por `updatedAt`) não ver o recém-disparado como antigo. O
// `now` fica um mês antes do relógio real: se o claim não o gravar, a hora real
// aparece no lugar. O `updatedAt` antigo da fixture vai por SQL cru (GH5).
const NOW = new Date('2026-10-21T12:00:00.000Z');
const DUE = new Date(NOW.getTime() - 60_000);
const CREATED = new Date('2026-10-20T08:00:00.000Z');

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: TeamWhatsappRepository;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const url = postgres.getConnectionUri();
  execFileSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
    { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } },
  );
  prisma = new PrismaClient({ datasources: { db: { url } } });
  repo = new TeamWhatsappRepository(
    prisma as never,
    new StaffScheduleRepository(prisma as never),
  );
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

/** Agendado vencido de um ADMIN, sem política (sem reconferência), com um destinatário. */
async function seedScheduled() {
  const channel = await prisma.channel.create({
    data: { name: 'Canal DH13', provider: 'EVOLUTION', isActive: true },
  });
  const user = await prisma.user.create({
    data: {
      email: 'dh13@test.local',
      password: 'x',
      name: 'Pessoa A',
      phoneE164: '+5592991110001',
      contactAuthorization: 'AUTORIZADO',
    },
  });
  const d = await prisma.teamWhatsappDispatch.create({
    data: {
      targetType: 'SECTOR',
      targetId: 'dh13',
      targetLabel: 'DH13',
      channelId: channel.id,
      text: 'oi',
      state: 'SCHEDULED',
      scheduledFor: DUE,
      recipients: {
        create: {
          userId: user.id,
          userName: 'Pessoa A',
          phoneE164: '+5592991110001',
          channelId: channel.id,
          status: 'SCHEDULED',
        },
      },
    },
    select: { id: true, recipients: { select: { id: true } } },
  });
  return { id: d.id, recipientId: d.recipients[0].id };
}

describe('claim do agendado — updatedAt (DH13)', () => {
  it('claim do agendado grava updatedAt com o now do disparo', async () => {
    const d = await seedScheduled();
    await prisma.$executeRaw`UPDATE "TeamWhatsappRecipient" SET "updatedAt" = ${CREATED} WHERE "id" = ${d.recipientId}`;
    const out = await repo.claimScheduled(d.id, NOW);
    expect(out?.queuedIds).toEqual([d.recipientId]);
    expect(
      await prisma.teamWhatsappRecipient.findUniqueOrThrow({
        where: { id: d.recipientId },
        select: { status: true, updatedAt: true },
      }),
    ).toEqual({ status: 'QUEUED', updatedAt: NOW });
  }, 60_000);
});
