import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma, type Role } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import { TeamAlertPanelService } from './team-alert-panel.service';
import { loadAlertHeader, loadAlertPeople } from './team-alert.repository';
import { TeamWhatsappRepository } from './team-whatsapp.repository';

// Lote I, T7 (CI5, DI8, DI9; aceites 6, 9, 12, 14, 16, 20): painel de pendências
// contra o Postgres real. Colunas de ciência semeadas direto; instantes
// explícitos em Manaus (-04:00); nada depende do relógio. Nomes fictícios.
const T0 = new Date('2026-11-20T09:00:00-04:00');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const iso = (min: number) => at(min).toISOString();

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: TeamWhatsappRepository;
let service: TeamAlertPanelService;
let channelId: string;
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
  repo = new TeamWhatsappRepository(
    prisma as never,
    new StaffScheduleRepository(prisma as never),
  );
  service = new TeamAlertPanelService(repo, prisma as never);
  const channel = await prisma.channel.create({
    data: { name: 'Canal painel', provider: 'EVOLUTION', isActive: true },
  });
  channelId = channel.id;
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

type UserOver = { name?: string; manages?: boolean };

/** Usuário com login; `manages` cria um setor ativo gerido por ele. */
async function user(role: Role, over: UserOver = {}): Promise<string> {
  const code = `painel-${++seq}`;
  const { id } = await prisma.user.create({
    data: {
      email: `${code}@test.local`,
      password: 'x',
      role,
      name: over.name ?? `Usuário ${code}`,
    },
  });
  if (over.manages ?? role !== 'ADMIN') {
    await prisma.sector.create({
      data: { name: `Setor ${code}`, code, managerId: id },
    });
  }
  return id;
}

type DispatchOver = Partial<Prisma.TeamWhatsappDispatchUncheckedCreateInput>;

/** Alerta urgente gravado direto (prazo de 15 min), `createdAt` = T0. */
async function alert(authorId: string, over: DispatchOver = {}) {
  const { id } = await prisma.teamWhatsappDispatch.create({
    data: {
      authorId,
      targetType: 'SECTOR',
      targetId: 'setor-painel',
      targetLabel: 'Logística',
      text: 'Vazamento no galpão\n\nResponda OK para confirmar que recebeu.',
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

type PersonOver = Partial<Prisma.TeamWhatsappRecipientUncheckedCreateInput>;

async function person(
  dispatchId: string,
  userName: string,
  over: PersonOver = {},
) {
  const { id } = await prisma.teamWhatsappRecipient.create({
    data: { dispatchId, userName, status: 'SENT', ...over },
    select: { id: true },
  });
  return id;
}

/** Mensagem recebida no chat (a resposta da pessoa). */
async function reply(
  content: string | null,
  min: number,
  kind: Prisma.MessageCreateInput['kind'] = 'TEXT',
) {
  const { id } = await prisma.message.create({
    data: {
      instanceId: channelId,
      direction: 'INBOUND',
      kind,
      content,
      receivedAt: at(min),
    },
    select: { id: true },
  });
  return id;
}

/** Lembrete do alerta (sem prazo), um destinatário por original pedido. */
async function reminder(
  alertId: string,
  authorId: string,
  min: number,
  parents: [string, Prisma.TeamWhatsappRecipientCreateInput['status']][],
) {
  const id = await alert(authorId, {
    parentDispatchId: alertId,
    ackDeadlineMinutes: null,
    createdAt: at(min),
  });
  for (const [parentRecipientId, status] of parents) {
    await person(id, 'Lembrado', { parentRecipientId, status });
  }
  return id;
}

const panelOf = (actorId: string, id: string) => service.getPanel(actorId, id);
const personIn = async (actorId: string, id: string, recipientId: string) =>
  (await panelOf(actorId, id)).people.find(
    (p) => p.recipientId === recipientId,
  );

describe('painel — grupos (aceite 6)', () => {
  it('aceite 6: quatro grupos na ordem e por nome; contagens', async () => {
    const admin = await user('ADMIN');
    const id = await alert(admin);
    await person(id, 'Bruno', { ackAt: at(3), ackKind: 'KEYWORD' });
    await person(id, 'Carla', { status: 'SKIPPED', skipReason: 'NO_PHONE' });
    await person(id, 'Ana', { status: 'FAILED' });
    await person(id, 'Álvaro', { status: 'QUEUED' });
    await person(id, 'Davi', { status: 'DELIVERED' });
    await person(id, 'Elisa', {
      status: 'READ',
      lastReplyMessageId: 'sem-message',
    });
    const panel = await panelOf(admin, id);
    expect(panel.people.map((p) => [p.group, p.userName])).toEqual([
      ['no_delivery', 'Álvaro'],
      ['no_delivery', 'Ana'],
      ['no_delivery', 'Carla'],
      ['no_reply', 'Davi'],
      ['replied', 'Elisa'],
      ['acked', 'Bruno'],
    ]);
    expect(panel.counts).toEqual({
      noDelivery: 3,
      noReply: 1,
      replied: 1,
      acked: 1,
    });
    expect(panel).toMatchObject({
      dispatchId: id,
      createdAt: iso(0),
      ackDeadlineMinutes: 15,
      ackDeadlineAt: iso(15),
    });
    expect(JSON.stringify(panel)).not.toMatch(/phone/i);
  });
});

describe('painel — ciência automática (aceite 6)', () => {
  it('aceite 6: ciência KEYWORD traz ackReply com o texto e a hora', async () => {
    const admin = await user('ADMIN');
    const id = await alert(admin);
    const ok = await reply('Ok!', 3);
    const rid = await person(id, 'Pessoa A', {
      status: 'REPLIED',
      ackAt: at(3),
      ackKind: 'KEYWORD',
      ackMessageId: ok,
      ackMessageAt: at(3),
      lastReplyMessageId: ok,
    });
    expect(await personIn(admin, id, rid)).toMatchObject({
      group: 'acked',
      status: 'REPLIED',
      ack: {
        at: iso(3),
        kind: 'keyword',
        late: false,
        byName: null,
        note: null,
      },
      ackReply: { text: 'Ok!', kind: 'TEXT', at: iso(3) },
      lastReply: { text: 'Ok!', kind: 'TEXT', at: iso(3) },
      eligible: false,
      mayHaveReceived: false,
    });
  });
});

describe('painel — ciência manual e prazo (aceites 11, 16)', () => {
  it('manual traz byName, note e a última resposta', async () => {
    const admin = await user('ADMIN', { name: 'Admin Central' });
    const id = await alert(admin);
    const audio = await reply(null, 4, 'AUDIO');
    const rid = await person(id, 'Pessoa B', {
      status: 'REPLIED',
      ackAt: at(6),
      ackKind: 'MANUAL',
      ackByUserId: admin,
      ackNote: 'Confirmou por telefone',
      lastReplyMessageId: audio,
    });
    expect(await personIn(admin, id, rid)).toMatchObject({
      group: 'acked',
      ack: {
        at: iso(6),
        kind: 'manual',
        late: false,
        byName: 'Admin Central',
        note: 'Confirmou por telefone',
      },
      ackReply: null,
      lastReply: { text: null, kind: 'AUDIO', at: iso(4) },
    });
  });

  it('aceite 16: ciência depois do prazo — late true; lembrete criado aos 10 min não muda ackDeadlineAt', async () => {
    const admin = await user('ADMIN');
    const id = await alert(admin, { reminderCount: 1, lastReminderAt: at(10) });
    const late = await person(id, 'Tarde', {
      ackAt: at(20),
      ackKind: 'KEYWORD',
    });
    const edge = await person(id, 'No limite', {
      ackAt: at(15),
      ackKind: 'KEYWORD',
    });
    await reminder(id, admin, 10, [[late, 'SENT']]);
    const panel = await panelOf(admin, id);
    expect(panel.ackDeadlineAt).toBe(iso(15));
    const ackOf = (rid: string) =>
      panel.people.find((p) => p.recipientId === rid)?.ack;
    expect(ackOf(late)).toMatchObject({ at: iso(20), late: true });
    expect(ackOf(edge)).toMatchObject({ at: iso(15), late: false });
  });
});

describe('painel — elegíveis ao lembrete (aceite 9)', () => {
  it('aceite 9: incerto que recebeu lembrete aceito — no_reply, eligible; falhou e pulado — no_delivery, não elegíveis; incerto — mayHaveReceived', async () => {
    const admin = await user('ADMIN');
    const id = await alert(admin, { reminderCount: 1, lastReminderAt: at(6) });
    const reached = await person(id, 'Incerto lembrado', {
      status: 'UNCERTAIN',
    });
    const failed = await person(id, 'Falhou', { status: 'FAILED' });
    const skipped = await person(id, 'Pulado', {
      status: 'SKIPPED',
      skipReason: 'NO_PHONE',
    });
    const uncertain = await person(id, 'Incerto', { status: 'UNCERTAIN' });
    await reminder(id, admin, 6, [[reached, 'SENT']]);
    const panel = await panelOf(admin, id);
    const view = (rid: string) => {
      const p = panel.people.find((x) => x.recipientId === rid);
      return [p?.group, p?.status, p?.eligible, p?.mayHaveReceived];
    };
    expect(view(reached)).toEqual(['no_reply', 'SENT', true, false]);
    expect(view(failed)).toEqual(['no_delivery', 'FAILED', false, false]);
    expect(view(skipped)).toEqual(['no_delivery', 'SKIPPED', false, false]);
    expect(view(uncertain)).toEqual(['no_delivery', 'UNCERTAIN', true, true]);
  });
});

describe('painel — lembretes (aceite 20, I7)', () => {
  it('aceite 20: lembrete do ADMIN aparece no painel do SUPERVISOR com o nome do autor e quantas pessoas', async () => {
    const admin = await user('ADMIN', { name: 'Admin Central' });
    const supervisor = await user('SUPERVISOR');
    const id = await alert(supervisor, {
      reminderCount: 1,
      lastReminderAt: at(7),
    });
    const a = await person(id, 'Pessoa A');
    const b = await person(id, 'Pessoa B', { status: 'DELIVERED' });
    const rem = await reminder(id, admin, 7, [
      [a, 'QUEUED'],
      [b, 'SENT'],
    ]);
    const panel = await panelOf(supervisor, id);
    expect(panel.reminders.items).toEqual([
      {
        dispatchId: rem,
        createdAt: iso(7),
        authorName: 'Admin Central',
        recipients: 2,
      },
    ]);
    expect(panel.people.map((p) => p.recipientId).sort()).toEqual(
      [a, b].sort(),
    );
  });
});

describe('painel — próximo lembrete (I7)', () => {
  it('nextAllowedAt = último lembrete + 5 min; null com 3 lembretes', async () => {
    const admin = await user('ADMIN');
    const none = await alert(admin);
    const two = await alert(admin, {
      reminderCount: 2,
      lastReminderAt: at(12),
    });
    const three = await alert(admin, {
      reminderCount: 3,
      lastReminderAt: at(20),
    });
    const remindersOf = async (id: string) =>
      (await panelOf(admin, id)).reminders;
    expect(await remindersOf(none)).toEqual({
      count: 0,
      max: 3,
      nextAllowedAt: iso(5),
      items: [],
    });
    expect(await remindersOf(two)).toMatchObject({
      count: 2,
      nextAllowedAt: iso(17),
    });
    expect(await remindersOf(three)).toMatchObject({
      count: 3,
      max: 3,
      nextAllowedAt: null,
    });
  });
});

describe('painel — mensagem apagada', () => {
  it('Message apagada — ackReply null', async () => {
    const admin = await user('ADMIN');
    const id = await alert(admin);
    const ok = await reply('OK', 2);
    const rid = await person(id, 'Pessoa C', {
      status: 'REPLIED',
      ackAt: at(2),
      ackKind: 'KEYWORD',
      ackMessageId: ok,
      ackMessageAt: at(2),
      lastReplyMessageId: ok,
    });
    await prisma.message.delete({ where: { id: ok } });
    expect(await personIn(admin, id, rid)).toMatchObject({
      group: 'acked',
      ack: { at: iso(2), kind: 'keyword' },
      ackReply: null,
      lastReply: null,
    });
  });
});

const denied = (status: number, code: string) => ({ status, code });

describe('painel — quem vê (aceite 12, GI5)', () => {
  it('aceite 12: SUPERVISOR autor sem a chave — 200', async () => {
    const KEY = { role: 'SUPERVISOR', key: 'equipe.urgencia' } as const;
    await prisma.rolePermission.deleteMany({ where: KEY });
    await prisma.rolePermission.create({ data: { ...KEY, granted: false } });
    const supervisor = await user('SUPERVISOR');
    expect((await repo.findActor(supervisor))?.permissions).not.toContain(
      'equipe.urgencia',
    );
    const id = await alert(supervisor);
    await person(id, 'Pessoa D');
    const panel = await panelOf(supervisor, id);
    expect(panel).toMatchObject({ dispatchId: id, counts: { noReply: 1 } });
  });

  it('outro SUPERVISOR — 404; VIEWER/sem remetente — 403', async () => {
    const author = await user('SUPERVISOR');
    const id = await alert(author);
    await person(id, 'Pessoa E');
    const other = await user('SUPERVISOR');
    const viewer = await user('VIEWER');
    const notManager = await user('OPERATOR', { manages: false });
    await expect(panelOf(other, id)).rejects.toMatchObject(
      denied(404, 'team_whatsapp.dispatch_not_found'),
    );
    for (const actor of [viewer, notManager, 'inexistente']) {
      await expect(panelOf(actor, id)).rejects.toMatchObject(
        denied(403, 'team_whatsapp.forbidden'),
      );
    }
    await expect(panelOf(viewer, 'nao-existe')).rejects.toMatchObject(
      denied(403, 'team_whatsapp.forbidden'),
    );
    await expect(panelOf(other, 'nao-existe')).rejects.toMatchObject(
      denied(404, 'team_whatsapp.dispatch_not_found'),
    );
    const admin = await user('ADMIN');
    expect((await panelOf(admin, id)).dispatchId).toBe(id);
  });
});

describe('painel — envio que não é alerta (aceite 14, I8)', () => {
  it('aceite 14: urgência antiga, reunião e lembrete — 422 not_an_alert', async () => {
    const admin = await user('ADMIN');
    const alertId = await alert(admin);
    const old = await alert(admin, { ackDeadlineMinutes: null });
    const meeting = await alert(admin, {
      purpose: 'MEETING',
      urgencyReason: null,
      ackDeadlineMinutes: null,
    });
    const rem = await reminder(alertId, admin, 6, []);
    for (const id of [old, meeting, rem]) {
      await expect(panelOf(admin, id)).rejects.toMatchObject(
        denied(422, 'team_whatsapp.not_an_alert'),
      );
    }
  });
});

describe('loadAlertHeader e loadAlertPeople (CI5)', () => {
  it('loadAlertHeader devolve createdAt, ackDeadlineMinutes, reminderCount e lastReminderAt; com o client e dentro de uma transação', async () => {
    const admin = await user('ADMIN');
    const id = await alert(admin, { reminderCount: 2, lastReminderAt: at(11) });
    const rid = await person(id, 'Pessoa F', { status: 'UNCERTAIN' });
    await reminder(id, admin, 11, [[rid, 'DELIVERED']]);
    const expected = {
      id,
      createdAt: T0,
      ackDeadlineMinutes: 15,
      reminderCount: 2,
      lastReminderAt: at(11),
    };
    expect(await loadAlertHeader(prisma, id)).toEqual(expected);
    const inTx = await prisma.$transaction(async (tx) => ({
      header: await loadAlertHeader(tx, id),
      people: await loadAlertPeople(tx, id),
    }));
    expect(inTx.header).toEqual(expected);
    expect(inTx.people).toMatchObject([
      { id: rid, status: 'UNCERTAIN', reminderStatuses: ['DELIVERED'] },
    ]);
    await expect(loadAlertHeader(prisma, 'nao-existe')).rejects.toMatchObject(
      denied(404, 'team_whatsapp.dispatch_not_found'),
    );
  });
});
