import { describe, expect, it, vi } from 'vitest';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import { TeamAlertPanelService } from './team-alert-panel.service';
import type { TeamActor } from './team-whatsapp.policy';

// CI5 (DI9): ordem de recusa do painel com repositório e banco falsos.
const T0 = new Date('2026-11-20T13:00:00.000Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

const supervisor = (id: string): TeamActor => ({
  ...actorWith('SUPERVISOR', { id }),
  managedSectorIds: ['s1'],
});

function person(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    userId: `u-${id}`,
    userName: `Pessoa ${id}`,
    status: 'SENT',
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
    ...over,
  };
}

function setup(actor: TeamActor | null, authorId = 'sup-1') {
  const repo = {
    findActor: vi.fn().mockResolvedValue(actor),
    findDispatchForActor: vi.fn().mockResolvedValue({
      id: 'd1',
      authorId,
      targetType: 'SECTOR',
      targetId: 's1',
      state: 'DISPATCHED',
      sectors: [{ sectorId: 's1' }],
    }),
  };
  const header = {
    id: 'd1',
    createdAt: T0,
    ackDeadlineMinutes: 15,
    reminderCount: 1,
    lastReminderAt: minutes(10),
  };
  const db = {
    teamWhatsappDispatch: {
      findUnique: vi.fn().mockResolvedValue(header),
      findMany: vi.fn().mockResolvedValue([]),
    },
    teamWhatsappRecipient: {
      findMany: vi.fn().mockResolvedValue([
        person('a', { ackAt: minutes(3), ackKind: 'KEYWORD' }),
        person('b', { status: 'FAILED' }),
        person('c', { lastReplyMessageId: 'm1', status: 'READ' }),
        person('d', {
          status: 'UNCERTAIN',
          reminderRecipients: [{ status: 'DELIVERED' }],
        }),
      ]),
    },
    message: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const service = new TeamAlertPanelService(repo as never, db as never);
  return { service, repo, db };
}

describe('TeamAlertPanelService.getPanel — recusas (DI9)', () => {
  it('getPanel: ator e visibilidade na ordem de requireVisible (403/404) antes de loadAlertHeader; nenhuma leitura de pessoas antes', async () => {
    const cases: [TeamActor | null, number][] = [
      [null, 403],
      [{ ...actorWith('VIEWER', { id: 'v' }), managedSectorIds: ['s1'] }, 403],
      [supervisor('sup-2'), 404],
    ];
    for (const [actor, status] of cases) {
      const { service, repo, db } = setup(actor);
      await expect(service.getPanel('x', 'd1')).rejects.toMatchObject({
        status,
      });
      expect(repo.findDispatchForActor).toHaveBeenCalledTimes(
        status === 404 ? 1 : 0,
      );
      expect(db.teamWhatsappDispatch.findUnique).not.toHaveBeenCalled();
      expect(db.teamWhatsappRecipient.findMany).not.toHaveBeenCalled();
    }
  });
});

describe('TeamAlertPanelService.getPanel — montagem (CI5)', () => {
  it('getPanel monta counts, reminders.count/max/nextAllowedAt a partir do cabeçalho e das pessoas', async () => {
    const { service, repo } = setup(supervisor('sup-1'));
    const panel = await service.getPanel('sup-1', 'd1');
    expect(repo.findActor).toHaveBeenCalledWith('sup-1');
    expect(panel).toMatchObject({
      dispatchId: 'd1',
      createdAt: T0.toISOString(),
      ackDeadlineMinutes: 15,
      ackDeadlineAt: minutes(15).toISOString(),
      counts: { noDelivery: 1, noReply: 1, replied: 1, acked: 1 },
      reminders: {
        count: 1,
        max: 3,
        nextAllowedAt: minutes(15).toISOString(),
        items: [],
      },
    });
    expect(panel.people.map((p) => [p.recipientId, p.group])).toEqual([
      ['b', 'no_delivery'],
      ['d', 'no_reply'],
      ['c', 'replied'],
      ['a', 'acked'],
    ]);
  });
});
