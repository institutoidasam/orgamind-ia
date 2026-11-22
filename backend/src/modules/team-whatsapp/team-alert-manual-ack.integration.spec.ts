import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import { TeamAlertAckService } from './team-alert-ack.service';
import { recordAlertReply } from './tracking/team-alert-reply';
import { TeamWhatsappRepository } from './team-whatsapp.repository';

// Lote I, T6 (CI6, DI7; aceites 11 e 22): ciência manual e desfazer contra o
// Postgres real, com o `recordAlertReply` real da T5 (DI6) nas corridas.
// Instantes explícitos em Manaus (-04:00); nada depende do relógio.
const T0 = new Date('2026-11-20T09:00:00-04:00');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const NOTE = 'confirmou por ligação';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let service: TeamAlertAckService;
let adminId: string;
let channelId: string;
const audit = { log: vi.fn().mockResolvedValue(undefined) };

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
  service = new TeamAlertAckService(repo, prisma as never, audit as never);
  const admin = await prisma.user.create({
    data: {
      email: 'ciencia-admin@test.local',
      password: 'x',
      role: 'ADMIN',
      name: 'Pessoa Admin',
    },
  });
  adminId = admin.id;
  const channel = await prisma.channel.create({
    data: { name: 'Canal ciência', provider: 'EVOLUTION', isActive: true },
  });
  channelId = channel.id;
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

type PersonOver = Partial<Prisma.TeamWhatsappRecipientUncheckedCreateInput>;

/** Alerta (prazo de 15 min) com uma pessoa que recebeu; `createdAt` = T0. */
async function alertPerson(over: PersonOver = {}) {
  const dispatch = await prisma.teamWhatsappDispatch.create({
    data: {
      authorId: adminId,
      targetType: 'SECTOR',
      targetId: 'setor-ciencia',
      targetLabel: 'Logística',
      text: 'Vazamento no galpão\n\nResponda OK para confirmar que recebeu.',
      purpose: 'URGENCY',
      urgencyReason: 'Vazamento',
      ackDeadlineMinutes: 15,
      createdAt: T0,
    },
    select: { id: true },
  });
  const person = await prisma.teamWhatsappRecipient.create({
    data: {
      dispatchId: dispatch.id,
      userName: 'Pessoa A',
      status: 'READ',
      acceptedAt: at(1),
      ...over,
    },
    select: { id: true },
  });
  return { d: dispatch.id, r: person.id };
}

const ackOf = (id: string) =>
  prisma.teamWhatsappRecipient.findUniqueOrThrow({
    where: { id },
    select: {
      ackAt: true,
      ackKind: true,
      ackByUserId: true,
      ackNote: true,
      ackMessageId: true,
      ackMessageAt: true,
      lastReplyMessageId: true,
    },
  });

const mark = (d: string, r: string, min = 5) =>
  service.markManual(adminId, d, r, { note: NOTE, now: at(min) });
const undo = (d: string, r: string) => service.undoManual(adminId, d, r);

/** O "OK" da pessoa pela gravação real da T5 (DI6 (a)→(b)→(c)). */
const okReply = (r: string, messageId: string, min = 6) =>
  recordAlertReply(prisma, {
    originalId: r,
    messageId,
    receivedAt: at(min),
    isAck: true,
  });

const manualAt5 = { ackAt: at(5), ackKind: 'MANUAL', ackNote: NOTE };
const keywordAt = (min: number, messageId: string) => ({
  ackAt: at(min),
  ackKind: 'KEYWORD',
  ackByUserId: null,
  ackNote: null,
  ackMessageId: messageId,
  ackMessageAt: at(min),
});

describe('ciência manual — marcar (aceite 11)', () => {
  it('aceite 11: marcar — MANUAL com autor, hora e observação', async () => {
    const { d, r } = await alertPerson({ lastReplyMessageId: 'resposta-1' });
    await mark(d, r);
    expect(await ackOf(r)).toEqual({
      ...manualAt5,
      ackByUserId: adminId,
      ackMessageId: null,
      ackMessageAt: null,
      lastReplyMessageId: 'resposta-1',
    });
    expect(audit.log).toHaveBeenLastCalledWith(
      'team_whatsapp.ack_manual',
      'TeamWhatsappRecipient',
      r,
      { actorId: adminId, dispatchId: d, recipientId: r },
    );
  });

  it('aceite 11: marcar de novo ou sobre automática — 422 ack_exists', async () => {
    const manual = await alertPerson();
    await mark(manual.d, manual.r);
    await expect(mark(manual.d, manual.r, 8)).rejects.toMatchObject({
      status: 422,
      code: 'team_whatsapp.ack_exists',
    });
    expect(await ackOf(manual.r)).toMatchObject(manualAt5);

    const auto = await alertPerson();
    await okReply(auto.r, 'ok-auto', 3);
    await expect(mark(auto.d, auto.r)).rejects.toMatchObject({
      status: 422,
      code: 'team_whatsapp.ack_exists',
    });
    expect(await ackOf(auto.r)).toMatchObject(keywordAt(3, 'ok-auto'));
  });
});

describe('ciência manual — desfazer (aceites 11 e 22)', () => {
  it('aceite 11: desfazer sem ackMessageId — volta à pendência', async () => {
    const { d, r } = await alertPerson({ lastReplyMessageId: 'resposta-2' });
    await mark(d, r);
    await undo(d, r);
    expect(await ackOf(r)).toEqual({
      ackAt: null,
      ackKind: null,
      ackByUserId: null,
      ackNote: null,
      ackMessageId: null,
      ackMessageAt: null,
      lastReplyMessageId: 'resposta-2',
    });
    expect(audit.log.mock.lastCall?.[3]).toEqual({
      actorId: adminId,
      dispatchId: d,
      recipientId: r,
      result: 'pending',
    });
  });

  it('aceite 11/22: desfazer com ackMessageId — KEYWORD com ackAt = ackMessageAt (hora do OK); autor e observação apagados', async () => {
    const { d, r } = await alertPerson();
    await mark(d, r);
    await okReply(r, 'ok-durante', 7);
    expect(await ackOf(r)).toMatchObject({
      ...manualAt5,
      ackMessageId: 'ok-durante',
    });
    await undo(d, r);
    expect(await ackOf(r)).toEqual({
      ...keywordAt(7, 'ok-durante'),
      lastReplyMessageId: 'ok-durante',
    });
    expect(audit.log.mock.lastCall?.[3]).toMatchObject({ result: 'keyword' });
  });
});

describe('ciência manual — desfazer sem ler a Message (DI7)', () => {
  it('desfazer com a Message do OK apagada — continua KEYWORD com a hora do OK (não lê a Message)', async () => {
    const { d, r } = await alertPerson();
    const message = await prisma.message.create({
      data: {
        instanceId: channelId,
        direction: 'INBOUND',
        kind: 'TEXT',
        content: 'OK',
        receivedAt: at(6),
      },
      select: { id: true },
    });
    await mark(d, r);
    await okReply(r, message.id, 6);
    await prisma.message.delete({ where: { id: message.id } });
    await undo(d, r);
    expect(await ackOf(r)).toMatchObject(keywordAt(6, message.id));
  });

  it('aceite 11: desfazer automática ou inexistente — 422 ack_not_manual', async () => {
    const auto = await alertPerson();
    await okReply(auto.r, 'ok-so-auto', 4);
    const pending = await alertPerson();
    for (const { d, r } of [auto, pending]) {
      await expect(undo(d, r)).rejects.toMatchObject({
        status: 422,
        code: 'team_whatsapp.ack_not_manual',
      });
    }
    expect(await ackOf(auto.r)).toMatchObject(keywordAt(4, 'ok-so-auto'));
    expect(await ackOf(pending.r)).toMatchObject({
      ackAt: null,
      ackKind: null,
    });
  });
});

type UpdateManyArgs = Prisma.TeamWhatsappRecipientUpdateManyArgs;

/**
 * `recordAlertReply` real com um gancho que roda a ação concorrente logo
 * depois da gravação `after` — (a) `lastReplyMessageId` ou (b) `ackMessageId`
 * — e antes da seguinte: força a intercalação, sem depender da sorte.
 */
function okReplyWith(after: 'a' | 'b', hook: () => Promise<unknown>) {
  const field = after === 'a' ? 'lastReplyMessageId' : 'ackMessageId';
  const db = {
    teamWhatsappRecipient: {
      updateMany: async (args: UpdateManyArgs) => {
        const result = await prisma.teamWhatsappRecipient.updateMany(args);
        if (field in args.data) await hook();
        return result;
      },
    },
  };
  return (r: string, messageId: string) =>
    recordAlertReply(db as never, {
      originalId: r,
      messageId,
      receivedAt: at(6),
      isAck: true,
    });
}

describe('corrida: ciência manual × OK (aceites 11 e 22)', () => {
  it('aceite 11/22: manual entre a gravação do ackMessageId e a da ciência — manual fica; o OK não sobrescreve; ackMessageId guardado', async () => {
    const { d, r } = await alertPerson();
    await okReplyWith('b', () => mark(d, r))(r, 'ok-entre');
    expect(await ackOf(r)).toEqual({
      ...manualAt5,
      ackByUserId: adminId,
      ackMessageId: 'ok-entre',
      ackMessageAt: at(6),
      lastReplyMessageId: 'ok-entre',
    });
  });

  it('aceite 11/22: manual e recordAlertReply(OK) ao mesmo tempo — uma ciência; a perdedora não grava; ackMessageId guardado', async () => {
    for (let n = 0; n < 6; n += 1) {
      const { d, r } = await alertPerson();
      const [manual] = await Promise.allSettled([
        mark(d, r),
        okReply(r, `ok-${n}`),
      ]);
      const { ackMessageId, ackMessageAt, lastReplyMessageId, ...ack } =
        await ackOf(r);
      const reason: unknown =
        manual.status === 'rejected' ? manual.reason : null;
      const outcome = {
        manual: (reason as { code?: string } | null)?.code ?? 'ok',
        ...ack,
      };
      expect([
        { manual: 'ok', ...manualAt5, ackByUserId: adminId },
        {
          manual: 'team_whatsapp.ack_exists',
          ackAt: at(6),
          ackKind: 'KEYWORD',
          ackByUserId: null,
          ackNote: null,
        },
      ]).toContainEqual(outcome);
      expect({ ackMessageId, ackMessageAt, lastReplyMessageId }).toEqual({
        ackMessageId: `ok-${n}`,
        ackMessageAt: at(6),
        lastReplyMessageId: `ok-${n}`,
      });
    }
  });
});

describe('corrida: desfazer × OK (aceite 22)', () => {
  it.each(['a', 'b'] as const)(
    'aceite 22: desfazer logo depois da gravação (%s) do OK — termina KEYWORD com a hora do OK',
    async (after) => {
      const { d, r } = await alertPerson();
      await mark(d, r);
      await okReplyWith(after, () => undo(d, r))(r, `ok-desfaz-${after}`);
      expect(await ackOf(r)).toMatchObject(keywordAt(6, `ok-desfaz-${after}`));
    },
  );

  it('aceite 22: desfazer e recordAlertReply(OK) ao mesmo tempo — sempre termina KEYWORD', async () => {
    for (let n = 0; n < 6; n += 1) {
      const { d, r } = await alertPerson();
      await mark(d, r);
      await Promise.all([undo(d, r), okReply(r, `ok-par-${n}`)]);
      expect(await ackOf(r)).toMatchObject(keywordAt(6, `ok-par-${n}`));
    }
  });
});
