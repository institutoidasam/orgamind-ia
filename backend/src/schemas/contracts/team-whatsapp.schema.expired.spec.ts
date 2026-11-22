import { describe, it, expect } from 'vitest';
import {
  audienceLateJoinedSnapshotSchema,
  audienceRuleSnapshotSchema,
  teamAudienceRuleViewSchema,
  teamDispatchDetailResponseSchema,
  teamDispatchRecipientPageSchema,
  teamDispatchStateSchema,
  teamScheduledListResponseSchema,
  teamSkipReasonSchema,
} from './team-whatsapp.schema';

const person = {
  userId: 'u1',
  name: 'Pessoa A',
  sectorId: 'log',
  sectorName: 'Logística',
  shiftName: 'Dia',
  levelName: null,
};

const COUNT_KEYS = [
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
];

const detail = (extra: Record<string, unknown> = {}) => ({
  id: 'd1',
  targetLabel: 'Logística',
  text: 'oi',
  state: 'DISPATCHED',
  createdAt: '2026-11-20T12:00:00.000Z',
  scheduledFor: '2026-11-21T13:00:00.000Z',
  firedAt: '2026-11-21T13:00:05.000Z',
  author: null,
  sectors: [{ id: 'log', name: 'Logística' }],
  counts: Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])),
  channels: [],
  leftOut: { unselected: [], off: [] },
  purpose: 'meeting',
  base: 'assigned',
  rule: null,
  excluded: [],
  ...extra,
});

const recipientPage = (extra: Record<string, unknown> = {}) => ({
  items: [
    {
      id: 'r1',
      userName: 'Pessoa A',
      sectorName: 'Logística',
      levelName: null,
      shiftName: 'Dia',
      status: 'SKIPPED',
      reason: 'VACATION',
      attempts: 0,
      channel: null,
      acceptedAt: null,
      deliveredAt: null,
      readAt: null,
      repliedAt: null,
      repeatable: false,
      ...extra,
    },
  ],
  total: 1,
  page: 1,
  pageSize: 50,
});

const scheduledList = (shift: unknown, rosterDate: unknown = '2026-11-21') => ({
  items: [
    {
      id: 'd1',
      scheduledFor: '2026-11-21T13:00:00.000Z',
      rosterDate,
      shift,
      label: 'Logística',
      recipientCount: 3,
      channel: null,
      author: null,
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
});

const ok =
  (schema: { safeParse: (v: unknown) => { success: boolean } }) =>
  (value: unknown) =>
    schema.safeParse(value).success;

describe('contrato do agendado: estado, motivos e lista (CG3)', () => {
  it('teamDispatchStateSchema aceita EXPIRED', () => {
    expect(teamDispatchStateSchema.parse('EXPIRED')).toBe('EXPIRED');
    expect(ok(teamDispatchStateSchema)('expired')).toBe(false);
  });

  it('motivos de pulo aceitam os da reconferência e do vencimento', () => {
    const novos = [
      'VACATION',
      'DAY_OFF',
      'LEFT_SECTOR',
      'PHONE_CHANGED',
      'EXPIRED',
    ];
    expect(novos.map(ok(teamSkipReasonSchema))).toEqual(novos.map(() => true));
    expect(ok(teamSkipReasonSchema)('vacation')).toBe(false);
  });

  it('item da lista de agendados aceita shift nulo', () => {
    const accepts = ok(teamScheduledListResponseSchema);
    expect(accepts(scheduledList(null))).toBe(true);
    expect(accepts(scheduledList(undefined))).toBe(false);
    expect(accepts(scheduledList(null, null))).toBe(false);
  });

  it('regra do painel aceita when at', () => {
    expect(teamAudienceRuleViewSchema.shape.when.parse('at')).toBe('at');
  });
});

describe('contrato do detalhe e dos destinatários (CG3, GG13)', () => {
  it('detalhe valida recheck ausente, nulo e preenchido', () => {
    const accepts = ok(teamDispatchDetailResponseSchema);
    const recheck = {
      at: '2026-11-21T13:00:01.000Z',
      skipped: 2,
      lateJoined: [person],
    };
    expect(accepts(detail())).toBe(true);
    expect(accepts(detail({ recheck: null }))).toBe(true);
    expect(accepts(detail({ recheck }))).toBe(true);
    expect(accepts(detail({ recheck: { ...recheck, skipped: -1 } }))).toBe(
      false,
    );
    expect(
      accepts(detail({ recheck: { ...recheck, lateJoined: [{ name: 'X' }] } })),
    ).toBe(false);
  });

  it('destinatário aceita phone ausente e nulo', () => {
    const accepts = ok(teamDispatchRecipientPageSchema);
    expect(accepts(recipientPage())).toBe(true);
    expect(accepts(recipientPage({ phone: null }))).toBe(true);
    expect(accepts(recipientPage({ phone: '+5592991110001' }))).toBe(true);
    expect(accepts(recipientPage({ phone: 1 }))).toBe(false);
  });
});

describe('snapshots gravados no envio (CG2, GG8)', () => {
  it('audienceLateJoinedSnapshotSchema descarta telefone', () => {
    const [saved] = audienceLateJoinedSnapshotSchema.parse([
      { ...person, phone: '+5592991110001', phoneE164: '+5592991110001' },
    ]);
    expect(saved).toEqual(person);
  });

  it('audienceRuleSnapshotSchema aceita when ausente', () => {
    const rule = {
      shifts: null,
      levels: [],
      withoutLevel: false,
      selectedUserIds: null,
    };
    expect(audienceRuleSnapshotSchema.parse(rule)).toEqual(rule);
    expect(audienceRuleSnapshotSchema.parse({ ...rule, when: 'at' })).toEqual({
      ...rule,
      when: 'at',
    });
    expect(ok(audienceRuleSnapshotSchema)({ ...rule, when: 'later' })).toBe(
      false,
    );
  });
});
