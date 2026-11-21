import { describe, expect, it } from 'vitest';
import {
  teamDispatchDetailResponseSchema,
  teamDispatchListResponseSchema,
} from './team-whatsapp.schema';

// CI10 (I3, I7, I8): prazo e lembrete na lista e no detalhe do histórico.
const NO_ALERT = {
  ackDeadlineMinutes: null,
  ackDeadlineAt: null,
  reminderOf: null,
};
const ALERT = {
  ackDeadlineMinutes: 15,
  ackDeadlineAt: '2026-11-20T13:15:00.000Z',
  reminderOf: null,
};
const REMINDER = {
  ackDeadlineMinutes: null,
  ackDeadlineAt: null,
  reminderOf: { dispatchId: 'd1', createdAt: '2026-11-20T13:00:00.000Z' },
};

const counts = Object.fromEntries(
  [
    'queued',
    'sent',
    'delivered',
    'read',
    'replied',
    'failed',
    'uncertain',
    'skipped',
    'scheduled',
    'cancelled',
  ].map((key) => [key, 0]),
);

const listItem = {
  id: 'd2',
  createdAt: '2026-11-20T13:10:00.000Z',
  author: null,
  target: { type: 'sector', id: 's1', label: 'Logística', shift: null },
  sectors: [{ id: 's1', name: 'Logística' }],
  channels: [],
  counts,
  rosterDate: null,
  state: 'DISPATCHED',
  scheduledFor: null,
  firedAt: null,
  purpose: 'urgency',
  base: null,
  activity: null,
  urgencyReason: 'Vazamento',
};

const detail = {
  id: 'd2',
  targetLabel: 'Logística',
  text: 'Lembrete: Vazamento',
  state: 'DISPATCHED',
  createdAt: '2026-11-20T13:10:00.000Z',
  scheduledFor: null,
  firedAt: null,
  author: null,
  sectors: [],
  counts,
  channels: [],
  leftOut: { unselected: [], off: [] },
  purpose: 'urgency',
  base: null,
  rule: null,
  excluded: [],
  recheck: null,
};

const list = (extra: object) => ({
  items: [{ ...listItem, ...extra }],
  total: 1,
  page: 1,
  pageSize: 20,
});
const listParses = (extra: object) =>
  teamDispatchListResponseSchema.safeParse(list(extra)).success;
const detailParses = (extra: object) =>
  teamDispatchDetailResponseSchema.safeParse({ ...detail, ...extra }).success;

describe('contrato do histórico — prazo e lembrete (CI10)', () => {
  it('item da lista e detalhe exigem ackDeadlineMinutes, ackDeadlineAt e reminderOf (nulos ou preenchidos)', () => {
    for (const fields of [NO_ALERT, ALERT, REMINDER]) {
      expect(listParses(fields)).toBe(true);
      expect(detailParses(fields)).toBe(true);
    }
    expect(listParses({})).toBe(false);
    expect(detailParses({})).toBe(false);
    for (const key of Object.keys(NO_ALERT)) {
      const missing = Object.fromEntries(
        Object.entries(ALERT).filter(([k]) => k !== key),
      );
      expect(listParses(missing)).toBe(false);
      expect(detailParses(missing)).toBe(false);
    }
    expect(listParses({ ...ALERT, reminderOf: { dispatchId: 'd1' } })).toBe(
      false,
    );
  });
});
