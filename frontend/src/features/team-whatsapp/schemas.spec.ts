import { describe, expect, it } from 'vitest';
import { dispatchListSchema } from './schemas';

const base = {
  createdAt: '2026-10-21T12:00:00.000Z',
  author: null,
  channel: null,
  rosterDate: '2026-10-21',
  firedAt: null,
  unselected: [],
  off: [],
};
const shift = { id: 'sh1', name: 'Noite', startTime: '22:00', endTime: '6h' };
const target = (label: string) => ({ type: 'sector', id: 's1', label, shift });
const recipient = (status: string) => ({ userId: 'u1', name: 'Ana', shiftName: 'Noite', status, reason: null });

describe('dispatchListSchema', () => {
  it('lê a lista com um envio agendado, um cancelado e o snapshot de turno tolerante', () => {
    const parsed = dispatchListSchema.parse({
      items: [
        {
          ...base, id: 'd1', target: target('Produção · Noite · 21/10'), state: 'SCHEDULED',
          scheduledFor: '2026-10-22T02:00:00.000Z',
          counts: { queued: 0, sent: 0, failed: 0, skipped: 0, scheduled: 1, cancelled: 0 },
          recipients: [recipient('SCHEDULED')],
        },
        {
          ...base, id: 'd2', target: target('Produção · Noite · 20/10'), state: 'CANCELLED', scheduledFor: null,
          counts: { queued: 0, sent: 0, failed: 0, skipped: 1, scheduled: 0, cancelled: 1 },
          recipients: [recipient('CANCELLED'), { ...recipient('SKIPPED'), reason: 'INACTIVE' }],
        },
      ],
    });
    expect(parsed.items.map((i) => i.state)).toEqual(['SCHEDULED', 'CANCELLED']);
  });
});
