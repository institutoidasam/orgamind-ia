import { describe, expect, it } from 'vitest';
import { teamDispatchRecipientPageSchema } from './team-whatsapp.schema';

// CH2/DH9: item de `GET dispatches/:id/recipients` com o rastreio do envio.
const item = (extra: Record<string, unknown>) => ({
  id: 'r1',
  userName: 'Pessoa A',
  sectorName: 'Logística',
  levelName: null,
  shiftName: 'Dia',
  status: 'SENT',
  reason: null,
  attempts: 2,
  channel: { name: 'GBR', phoneE164: '+559230001111' },
  acceptedAt: null,
  deliveredAt: null,
  readAt: null,
  repliedAt: null,
  repeatable: false,
  phone: null,
  channelCheckedAt: null,
  manualRetries: 0,
  ...extra,
});

const accepts = (extra: Record<string, unknown> = {}) =>
  teamDispatchRecipientPageSchema.safeParse({
    items: [item(extra)],
    total: 1,
    page: 1,
    pageSize: 50,
  }).success;

describe('item de destinatário com rastreio (H1, H4)', () => {
  it('item de destinatário exige channelCheckedAt (nulo ou ISO) e manualRetries', () => {
    expect(accepts()).toBe(true);
    expect(
      accepts({
        channelCheckedAt: '2026-11-20T13:00:09.000Z',
        manualRetries: 1,
      }),
    ).toBe(true);
    expect(accepts({ channelCheckedAt: undefined })).toBe(false);
    expect(accepts({ manualRetries: undefined })).toBe(false);
    expect(accepts({ manualRetries: -1 })).toBe(false);
  });
});
