import type { Role, TeamDispatchPurpose } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { newConversation } from '../chat/conversation-ownership.test-fixtures';
import { TeamConversationDispatchService } from './team-conversation-dispatch.service';
import {
  T0,
  at,
  newPendency,
  newSector,
  newTeamUser,
  startPendencyDb,
  stopPendencyDb,
  type NewPendencyInput,
  type PendencyDb as TestDb,
} from './team-pendency.test-fixtures';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-conversation-dispatch.integration.spec.ts
 * "Último envio à equipe nesta conversa" (K3-6, DT7, aceite 29): finalidade e data
 * a quem tem a caixa; situação só no alcance K2-4; `dispatchId` só com `canViewDispatch`.
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const NOW = T0;

let db: TestDb;
let service: TeamConversationDispatchService;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  service = new TeamConversationDispatchService(
    db.prisma as unknown as PrismaService,
  );
}, 180_000);

afterAll(async () => {
  if (ENABLED) await stopPendencyDb(db);
});

type DispatchSeed = {
  authorId?: string;
  createdAt: Date;
  firedAt?: Date;
  purpose?: TeamDispatchPurpose;
  ackDeadlineMinutes?: number;
  parentDispatchId?: string;
};

/** Envio da equipe; sem `ackDeadlineMinutes` ele não é alerta. */
async function newDispatch(seed: DispatchSeed): Promise<string> {
  const row = await db.prisma.teamWhatsappDispatch.create({
    data: {
      targetType: 'SECTOR',
      targetId: 'setor-k3',
      targetLabel: 'Logística',
      text: 'Texto do envio',
      ...seed,
    },
    select: { id: true },
  });
  return row.id;
}

/** Mensagem do envio na conversa (minuto `minute` a partir de T0) e o destinatário que a aponta. */
async function sentInto(
  conversationId: string,
  minute: number,
  dispatchId: string,
  extra: Omit<NewPendencyInput, 'dispatchId' | 'messageId'> & {
    parentRecipientId?: string;
  } = {},
): Promise<string> {
  const message = await db.prisma.message.create({
    data: {
      conversationId,
      instanceId: db.channelId,
      direction: 'OUTBOUND',
      status: 'SENT',
      content: 'mensagem',
      createdAt: at(minute),
    },
    select: { id: true },
  });
  const { parentRecipientId, ...pendency } = extra;
  const id = await newPendency(db, {
    ...pendency,
    dispatchId,
    messageId: message.id,
  });
  if (parentRecipientId !== undefined) {
    await db.prisma.teamWhatsappRecipient.update({
      where: { id },
      data: { parentRecipientId },
    });
  }
  return id;
}

/** Gestor ativo de um setor novo, com o papel dado. */
async function manager(role: Role) {
  const user = await newTeamUser(db, { role });
  const sector = await newSector(db, { managerId: user.id });
  return { id: user.id, sectorId: sector.id, sectorName: sector.name };
}

const run = (actorId: string, conversationId: string) =>
  service.lastDispatch(actorId, conversationId, NOW);

describe.skipIf(!ENABLED)('último envio — conversa e escolha do envio', () => {
  it('sem envio — last null', async () => {
    const admin = await newTeamUser(db, { role: 'ADMIN' });
    const conv = await newConversation(db);
    expect(await run(admin.id, conv)).toEqual({ last: null });
  });

  it('conversa inexistente — 404', async () => {
    const admin = await newTeamUser(db, { role: 'ADMIN' });
    await expect(run(admin.id, 'nao-existe')).rejects.toMatchObject({
      status: 404,
      code: 'conversation.not_found',
    });
  });

  it('último = o de mensagem mais nova, não o de envio mais novo', async () => {
    const admin = await newTeamUser(db, { role: 'ADMIN' });
    const conv = await newConversation(db);
    const older = await newDispatch({ createdAt: at(-5), purpose: 'MEETING' });
    const newer = await newDispatch({ createdAt: at(-9), purpose: 'LECTURE' });
    await sentInto(conv, 1, older);
    await sentInto(conv, 5, newer);
    const { last } = await run(admin.id, conv);
    expect(last).toMatchObject({ purpose: 'lecture', dispatchId: newer });
  });

  it('envio agendado — a data é a do disparo, não a da criação', async () => {
    const admin = await newTeamUser(db, { role: 'ADMIN' });
    const conv = await newConversation(db);
    const scheduled = await newDispatch({
      createdAt: at(-120),
      firedAt: at(-10),
      purpose: 'MEETING',
    });
    await sentInto(conv, 1, scheduled);
    const { last } = await run(admin.id, conv);
    expect(last?.sentAt).toBe(at(-10).toISOString());
  });
});

/** Alerta urgente (ciência em 15 min, enviado 30 min antes de T0) do autor dado. */
const alertBy = (authorId: string) =>
  newDispatch({
    authorId,
    createdAt: at(-30),
    purpose: 'URGENCY',
    ackDeadlineMinutes: 15,
  });

describe.skipIf(!ENABLED)('último envio — ADMIN e quem não é remetente', () => {
  it('aceite 29: ADMIN — finalidade, data, situação e dispatchId', async () => {
    const admin = await newTeamUser(db, { role: 'ADMIN' });
    const author = await manager('OPERATOR');
    const conv = await newConversation(db);
    const alert = await alertBy(author.id);
    await sentInto(conv, 1, alert, {
      handlerId: admin.id,
      assignedAt: at(-5),
      dueAt: at(55),
    });
    expect(await run(admin.id, conv)).toEqual({
      last: {
        purpose: 'urgency',
        sentAt: at(-30).toISOString(),
        isReminder: false,
        dispatchId: alert,
        pendency: { situation: 'IN_PROGRESS' },
      },
    });
  });

  it('aceite 29: OPERATOR não remetente — sem situação e sem dispatchId', async () => {
    const operator = await newTeamUser(db, { role: 'OPERATOR' });
    const author = await manager('OPERATOR');
    const conv = await newConversation(db);
    const alert = await alertBy(author.id);
    await sentInto(conv, 1, alert, { sectorId: author.sectorId });
    expect(await run(operator.id, conv)).toEqual({
      last: {
        purpose: 'urgency',
        sentAt: at(-30).toISOString(),
        isReminder: false,
        dispatchId: null,
        pendency: null,
      },
    });
  });
});

describe.skipIf(!ENABLED)('último envio — OPERATOR gestor de setor', () => {
  it('gestor do setor da pessoa, sem ser autor — situação sim, dispatchId null', async () => {
    const boss = await manager('OPERATOR');
    const author = await newTeamUser(db, { role: 'ADMIN' });
    const conv = await newConversation(db);
    await sentInto(conv, 1, await alertBy(author.id), {
      sectorId: boss.sectorId,
    });
    const { last } = await run(boss.id, conv);
    expect(last).toMatchObject({
      dispatchId: null,
      pendency: { situation: 'UNASSIGNED' },
    });
  });

  it('gestor de outro setor, sem ser autor — sem situação e sem dispatchId', async () => {
    const outsider = await manager('OPERATOR');
    const author = await manager('OPERATOR');
    const conv = await newConversation(db);
    await sentInto(conv, 1, await alertBy(author.id), {
      sectorId: author.sectorId,
    });
    const { last } = await run(outsider.id, conv);
    expect(last).toMatchObject({ dispatchId: null, pendency: null });
  });
});

describe.skipIf(!ENABLED)('último envio — autor e envio sem alerta', () => {
  it('autor do alerta, mesmo fora do setor — vê dispatchId e situação', async () => {
    const author = await manager('OPERATOR');
    const other = await manager('OPERATOR');
    const conv = await newConversation(db);
    const alert = await alertBy(author.id);
    await sentInto(conv, 1, alert, { sectorId: other.sectorId });
    const { last } = await run(author.id, conv);
    expect(last).toMatchObject({
      dispatchId: alert,
      pendency: { situation: 'UNASSIGNED' },
    });
  });

  it('envio que não é alerta — sem situação, com dispatchId para quem vê o envio', async () => {
    const admin = await newTeamUser(db, { role: 'ADMIN' });
    const conv = await newConversation(db);
    const meeting = await newDispatch({
      createdAt: at(-5),
      purpose: 'MEETING',
    });
    await sentInto(conv, 1, meeting);
    const { last } = await run(admin.id, conv);
    expect(last).toMatchObject({
      purpose: 'meeting',
      dispatchId: meeting,
      pendency: null,
    });
  });
});

describe.skipIf(!ENABLED)('último envio — autor sem ser remetente', () => {
  it('aceite 29: autor que deixou de ser remetente — dispatchId null', async () => {
    // OPERATOR sem setor gerido: o servidor recusa a tela de resultado (403), então o link não aparece.
    const formerSender = await newTeamUser(db, { role: 'OPERATOR' });
    const other = await manager('OPERATOR');
    const conv = await newConversation(db);
    await sentInto(conv, 1, await alertBy(formerSender.id), {
      sectorId: other.sectorId,
    });
    const { last } = await run(formerSender.id, conv);
    expect(last).toMatchObject({
      purpose: 'urgency',
      dispatchId: null,
      pendency: null,
    });
  });
});

describe.skipIf(!ENABLED)('último envio — lembrete do alerta (DT7)', () => {
  it('lembrete é o último — isReminder; situação pela linha do alerta pai e dispatchId pelo alerta pai', async () => {
    const boss = await manager('OPERATOR');
    const admin = await newTeamUser(db, { role: 'ADMIN' });
    const conv = await newConversation(db);
    const alert = await newDispatch({
      authorId: boss.id,
      createdAt: at(-30),
      purpose: 'URGENCY',
      ackDeadlineMinutes: 15,
    });
    // Outra linha do mesmo alerta, já ciente: a situação tem de vir da linha apontada pelo lembrete.
    await newPendency(db, {
      dispatchId: alert,
      sectorId: boss.sectorId,
      ackAt: at(-20),
    });
    const open = await newPendency(db, {
      dispatchId: alert,
      sectorId: boss.sectorId,
    });
    const reminder = await newDispatch({
      authorId: admin.id,
      createdAt: at(-3),
      purpose: 'URGENCY',
      parentDispatchId: alert,
    });
    await sentInto(conv, 2, reminder, { parentRecipientId: open });
    const { last } = await run(boss.id, conv);
    expect(last).toEqual({
      purpose: 'urgency',
      sentAt: at(-3).toISOString(),
      isReminder: true,
      dispatchId: alert,
      pendency: { situation: 'UNASSIGNED' },
    });
  });
});
