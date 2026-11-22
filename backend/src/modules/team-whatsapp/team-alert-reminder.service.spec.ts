import { describe, expect, it, vi } from 'vitest';
import type { TeamWhatsappRecipientStatus } from '@prisma/client';
import { teamReminderResponseSchema } from '../../schemas/contracts/team-whatsapp.schema';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import type { LiveState } from '../whatsapp-providers/channel-live-state.service';
import { sendReminderSchema } from './dto/send-reminder.dto';
import { TeamAlertReminderService } from './team-alert-reminder.service';
import type { TeamActor } from './team-whatsapp.policy';

// CI7 (I7, DI10; aceites 10, 12): recusas, ordem e trilha do lembrete com
// repositório, banco, porta ao vivo, fila e trilha falsos. A troca condicional,
// a corrida e a gravação real ficam em team-alert-reminder.integration.spec.ts.
const T0 = new Date('2026-11-20T13:00:00.000Z');
const min = (m: number) => new Date(T0.getTime() + m * 60_000);
const NOW = min(30);

const withKey = (id: string, managed = ['s1']): TeamActor => ({
  ...actorWith('SUPERVISOR', { id, grant: ['equipe.urgencia'] }),
  managedSectorIds: managed,
});

type Setup = {
  actor?: TeamActor | null;
  authorId?: string;
  deadline?: number | null;
  reminderCount?: number;
  lastReminderAt?: Date | null;
  statuses?: TeamWhatsappRecipientStatus[];
  phones?: (string | null)[];
  live?: LiveState;
};

/** Pessoa do alerta `r<n>` (usuário `u-r<n>`), sem ciência nem resposta. */
const personRow = (n: number, status: TeamWhatsappRecipientStatus) => ({
  id: `r${n}`,
  userId: `u-r${n}`,
  userName: `Pessoa ${n}`,
  status,
  sectorId: 's1',
  sectorName: 'Logística',
  shiftId: null,
  shiftName: null,
  levelName: null,
  ackAt: null,
  ackKind: null,
  ackByUserId: null,
  ackNote: null,
  ackMessageId: null,
  lastReplyMessageId: null,
  reminderRecipients: [],
});

function fakeDb(s: Setup) {
  const statuses = s.statuses ?? ['SENT'];
  const phones = s.phones ?? statuses.map((_, i) => `+559299111000${i}`);
  const db = {
    teamWhatsappDispatch: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'a1',
        createdAt: T0,
        ackDeadlineMinutes: s.deadline === undefined ? 15 : s.deadline,
        reminderCount: s.reminderCount ?? 0,
        lastReminderAt: s.lastReminderAt ?? null,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        targetType: 'SECTOR',
        targetId: 's1',
        text: 'Vazamento',
        sectors: [{ sectorId: 's1', sectorName: 'Logística' }],
      }),
      create: vi.fn().mockResolvedValue({ id: 'rem-1' }),
    },
    teamWhatsappDispatchSector: { createMany: vi.fn() },
    teamWhatsappRecipient: {
      findMany: vi
        .fn()
        .mockResolvedValue(statuses.map((st, i) => personRow(i + 1, st))),
      createManyAndReturn: vi.fn((a: { data: { status: string }[] }) =>
        Promise.resolve(
          a.data.map((r, i) => ({ id: `rr-${i}`, status: r.status })),
        ),
      ),
    },
    user: {
      findMany: vi.fn().mockResolvedValue(
        phones.map((phoneE164, i) => ({
          id: `u-r${i + 1}`,
          phoneE164,
          contact: null,
          contactAuthorization: 'AUTORIZADO',
        })),
      ),
    },
    $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(db)),
  };
  return db;
}

const SECTOR_NUMBERS = new Map([
  [
    's1',
    {
      id: 'c1',
      name: 'Canal',
      phoneE164: null,
      provider: 'EVOLUTION',
      evolutionInstanceName: 'i1',
    },
  ],
]);

function fakeRepo(s: Setup) {
  const actor = s.actor === undefined ? withKey('sup-1') : s.actor;
  return {
    findActor: vi.fn().mockResolvedValue(actor),
    findDispatchForActor: vi.fn().mockResolvedValue({
      id: 'a1',
      authorId: s.authorId ?? 'sup-1',
      targetType: 'SECTOR',
      targetId: 's1',
      state: 'DISPATCHED',
      sectors: [{ sectorId: 's1' }],
    }),
    findSector: vi.fn().mockResolvedValue({ id: 's1', isActive: true }),
    findSectorChannels: vi.fn().mockResolvedValue(SECTOR_NUMBERS),
    markFailed: vi.fn(),
  };
}

/** Porta ao vivo falsa: o mesmo estado para todo número. */
const fakeLive = (state: LiveState) => ({
  checkMany: vi.fn((chs: { id: string }[]) =>
    Promise.resolve(
      new Map(
        chs.map((c) => [c.id, { channelId: c.id, state, checkedAt: NOW }]),
      ),
    ),
  ),
});

function setup(s: Setup = {}) {
  const repo = fakeRepo(s);
  const db = fakeDb(s);
  const live = fakeLive(s.live ?? 'open');
  const queue = { addBulk: vi.fn().mockResolvedValue([]) };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new TeamAlertReminderService(
    repo as never,
    db as never,
    audit as never,
    queue as never,
  );
  const consent = { isSuppressed: vi.fn().mockResolvedValue(false) };
  Object.assign(service, { live, consent });
  const send = () =>
    service.send('x', 'a1', { recipientIds: ['r1', 'r2'] }, NOW);
  return { repo, db, live, queue, audit, send };
}

describe('sendReminderSchema (CI7)', () => {
  it('1 a 500 ids, sem repetição — senão 400', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);
    expect(sendReminderSchema.safeParse({ recipientIds: ids(1) }).success).toBe(
      true,
    );
    expect(
      sendReminderSchema.safeParse({ recipientIds: ids(500) }).success,
    ).toBe(true);
    for (const recipientIds of [[], ids(501), ['r1', 'r1'], ['']]) {
      expect(sendReminderSchema.safeParse({ recipientIds }).success).toBe(
        false,
      );
    }
  });
});

describe('TeamAlertReminderService — chave antes de tudo (aceite 12, GI4)', () => {
  it('aceite 12: sem a chave — 403 antes de buscar o alerta, inclusive invisível', async () => {
    const withoutKey = {
      ...actorWith('SUPERVISOR', { id: 'sup-1' }),
      managedSectorIds: ['s1'],
    };
    for (const authorId of ['sup-1', 'outro']) {
      const f = setup({ actor: withoutKey, authorId });
      await expect(f.send()).rejects.toMatchObject({
        status: 403,
        code: 'auth.permission_denied',
        detail: 'Você não tem permissão para criar alerta urgente.',
      });
      expect(f.repo.findDispatchForActor).not.toHaveBeenCalled();
      expect(f.db.teamWhatsappRecipient.findMany).not.toHaveBeenCalled();
      expect(f.db.$transaction).not.toHaveBeenCalled();
    }
  });
});

describe('TeamAlertReminderService — visível, remetente e área (aceites 10, 12)', () => {
  it('invisível — 404; não remetente — 403; aceite 10: autor que deixou de gerir o setor — 403', async () => {
    const invisible = setup({
      actor: withKey('sup-2', ['s9']),
      authorId: 'sup-1',
    });
    await expect(invisible.send()).rejects.toMatchObject({ status: 404 });
    const notSender = setup({ actor: withKey('sup-1', []) });
    await expect(notSender.send()).rejects.toMatchObject({
      status: 403,
      code: 'team_whatsapp.forbidden',
    });
    const leftSector = setup({ actor: withKey('sup-1', ['s9']) });
    await expect(leftSector.send()).rejects.toMatchObject({
      status: 403,
      code: 'team_whatsapp.forbidden',
    });
    expect(leftSector.repo.findSector).toHaveBeenCalledWith('s1');
    for (const f of [invisible, notSender, leftSector]) {
      expect(f.db.teamWhatsappDispatch.findUnique).not.toHaveBeenCalled();
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(f.queue.addBulk).not.toHaveBeenCalled();
    }
  });

  it('reunião, urgência antiga ou lembrete — 422 not_an_alert', async () => {
    const f = setup({ deadline: null });
    await expect(f.send()).rejects.toMatchObject({
      status: 422,
      code: 'team_whatsapp.not_an_alert',
    });
    expect(f.db.teamWhatsappRecipient.findMany).not.toHaveBeenCalled();
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });
});

describe('TeamAlertReminderService — ordem das recusas antes da transação (I7, GI4)', () => {
  it('ordem: reminder_empty antes de reminder_limit antes de reminder_too_soon antes do canal', async () => {
    const cases: [Setup, number, string][] = [
      [
        { statuses: ['FAILED'], reminderCount: 3, lastReminderAt: min(29) },
        422,
        'team_whatsapp.reminder_empty',
      ],
      [
        { reminderCount: 3, lastReminderAt: min(29) },
        409,
        'team_whatsapp.reminder_limit',
      ],
      [
        { reminderCount: 1, lastReminderAt: min(26) },
        409,
        'team_whatsapp.reminder_too_soon',
      ],
      [
        { reminderCount: 1, lastReminderAt: min(25) },
        409,
        'team_whatsapp.channel_disconnected',
      ],
    ];
    for (const [s, status, code] of cases) {
      const f = setup({ ...s, live: 'close' });
      await expect(f.send()).rejects.toMatchObject({ status, code });
      expect(f.db.$transaction).not.toHaveBeenCalled();
    }
  });
});

describe('TeamAlertReminderService — canal e telefone antes da transação (D7, C8)', () => {
  it('canal fechado — 409 sem abrir a transação', async () => {
    for (const [live, code] of [
      ['close', 'team_whatsapp.channel_disconnected'],
      ['unknown', 'team_whatsapp.channel_unverified'],
    ] as const) {
      const f = setup({ live });
      await expect(f.send()).rejects.toMatchObject({ status: 409, code });
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(f.queue.addBulk).not.toHaveBeenCalled();
      expect(f.audit.log).not.toHaveBeenCalled();
    }
  });

  it('ninguém com telefone — 422 no_recipients, como no envio "agora", sem transação nem porta ao vivo', async () => {
    const f = setup({ phones: [null] });
    await expect(f.send()).rejects.toMatchObject({
      status: 422,
      code: 'team_whatsapp.no_recipients',
    });
    expect(f.live.checkMany).not.toHaveBeenCalled();
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });
});

describe('TeamAlertReminderService — fila e trilha (I7, GI3)', () => {
  it('trilha reminder com actorId, alertId, reminderId e queued, sem nome', async () => {
    const f = setup({
      statuses: ['SENT', 'REPLIED'],
      phones: ['+5592991110001', null],
    });
    const result = await f.send();
    expect(teamReminderResponseSchema.parse(result)).toEqual({
      reminderId: 'rem-1',
      queued: 1,
    });
    expect(f.queue.addBulk).toHaveBeenCalledWith([
      { name: 'send', data: { recipientId: 'rr-0' }, opts: { jobId: 'rr-0' } },
    ]);
    expect(f.audit.log).toHaveBeenCalledWith(
      'team_whatsapp.reminder',
      'TeamWhatsappDispatch',
      'rem-1',
      {
        actorId: 'sup-1',
        alertId: 'a1',
        reminderId: 'rem-1',
        queued: 1,
        skipped: 1,
      },
    );
    const trail = JSON.stringify(f.audit.log.mock.calls);
    expect(trail).not.toMatch(/Pessoa|Vazamento|\+5592/);
  });
});
