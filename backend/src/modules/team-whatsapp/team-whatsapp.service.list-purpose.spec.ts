import { beforeEach, describe, expect, it } from 'vitest';
import { teamDispatchListResponseSchema } from '../../schemas/contracts/team-whatsapp.schema';
import type { TeamDispatchRow } from './team-whatsapp.repository';
import {
  ADMIN,
  NO_SNAPSHOT,
  createHarness,
  type Harness,
} from './team-whatsapp.test-fixtures';

const PAGE = { page: 1, pageSize: 20 };

const NO_PURPOSE = {
  purpose: null,
  audienceBase: null,
  activityDate: null,
  activityTime: null,
  activityPlace: null,
  urgencyReason: null,
  ackDeadlineMinutes: null,
  parentDispatch: null,
};

const listRow = (over: Partial<TeamDispatchRow>): TeamDispatchRow => ({
  ...NO_SNAPSHOT,
  ...NO_PURPOSE,
  id: 'd1',
  targetType: 'SECTOR',
  targetId: 's1',
  targetLabel: 'Financeiro',
  createdAt: new Date('2026-11-20T12:00:00.000Z'),
  rosterDate: new Date('2026-11-25T00:00:00.000Z'),
  state: 'DISPATCHED',
  scheduledFor: null,
  firedAt: null,
  author: null,
  sectors: [{ sectorId: 's1', sectorName: 'Financeiro' }],
  ...over,
});

let h: Harness;
beforeEach(() => {
  h = createHarness();
  h.repo.findActor.mockResolvedValue(ADMIN);
});

async function listOf(rows: TeamDispatchRow[]) {
  h.repo.listDispatches.mockResolvedValue({ rows, total: rows.length });
  const out = await h.service.listDispatches('a', PAGE);
  return { out, parsed: teamDispatchListResponseSchema.parse(out) };
}

describe('TeamWhatsappService.listDispatches — finalidade (CF3)', () => {
  it('lista traz finalidade, base e atividade', async () => {
    const meeting = listRow({
      purpose: 'MEETING',
      audienceBase: 'ASSIGNED',
      activityDate: new Date('2026-11-25T00:00:00.000Z'),
      activityTime: '09:00',
      activityPlace: 'Sala 2',
    });
    const urgency = listRow({
      id: 'd2',
      purpose: 'URGENCY',
      audienceBase: 'ON_DUTY',
      urgencyReason: 'Queda de energia',
    });
    const { parsed } = await listOf([meeting, urgency]);
    expect(
      parsed.items.map((i) => [i.purpose, i.base, i.activity, i.urgencyReason]),
    ).toEqual([
      [
        'meeting',
        'assigned',
        { date: '2026-11-25', time: '09:00', place: 'Sala 2' },
        null,
      ],
      ['urgency', 'on_duty', null, 'Queda de energia'],
    ]);
  });

  it('aceite 13: envio sem finalidade traz as quatro chaves presentes e nulas', async () => {
    const { out } = await listOf([listRow({})]);
    const [item] = out.items;
    expect(Object.keys(item)).toEqual(
      expect.arrayContaining(['purpose', 'base', 'activity', 'urgencyReason']),
    );
    expect(item).toMatchObject({
      purpose: null,
      base: null,
      activity: null,
      urgencyReason: null,
    });
  });
});
