import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AlertRow,
  type DetailPurposeRow,
  purposeDetail,
  purposeView,
} from './dispatch-purpose-view';

const SECTORS = [{ id: 's1', name: 'Financeiro' }];

const RULE = {
  shifts: [{ id: 't1', name: '1º turno' }],
  levels: [{ id: 'n1', name: 'Pleno' }],
  withoutLevel: true,
  selectedUserIds: ['u1', 'u2'],
};

const EXCLUDED = [
  {
    userId: 'u3',
    name: 'Bia Souza',
    sectorId: 's1',
    sectorName: 'Financeiro',
    shiftName: null,
    levelName: null,
    reason: 'day_off',
  },
];

type Row = DetailPurposeRow & AlertRow;

const row = (over: Partial<Row> = {}): Row => ({
  id: 'd1',
  createdAt: new Date('2026-11-20T12:00:00.000Z'),
  ackDeadlineMinutes: null,
  parentDispatch: null,
  purpose: 'SHIFT_NOTICE',
  audienceBase: 'ON_DUTY',
  includeOff: false,
  rosterDate: new Date('2026-11-21T00:00:00.000Z'),
  activityDate: null,
  activityTime: null,
  activityPlace: null,
  urgencyReason: null,
  audienceRule: RULE,
  audienceExcluded: EXCLUDED,
  scheduledFor: null,
  schedulePolicy: null,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('purposeView — atividade', () => {
  it('atividade parcial sai com as partes gravadas; tudo nulo = sem atividade', () => {
    expect(
      purposeView(row({ activityTime: '14:00', activityPlace: null })),
    ).toEqual({
      purpose: 'shift_notice',
      base: 'on_duty',
      activity: { date: null, time: '14:00', place: null },
      urgencyReason: null,
      ackDeadlineMinutes: null,
      ackDeadlineAt: null,
      reminderOf: null,
    });
    expect(purposeView(row()).activity).toBeNull();
  });
});

describe('purposeDetail — painel da regra', () => {
  it('agendado: when shift_start, scheduledFor ISO e selectedCount pela seleção gravada', () => {
    const at = new Date('2026-11-21T11:00:00.000Z');
    const { rule } = purposeDetail(row({ scheduledFor: at }), SECTORS, true);
    expect(rule).toMatchObject({
      when: 'shift_start',
      scheduledFor: '2026-11-21T11:00:00.000Z',
      schedulePolicy: null,
      selectedCount: 2,
      rosterDate: '2026-11-21',
      sectors: SECTORS,
      shifts: RULE.shifts,
      withoutLevel: true,
    });
  });

  it('regra fora do formato: rule null e registro sem nome nem dado gravado', () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const corrupt = { shifts: 'Bia Souza', levels: [] };
    const out = purposeDetail(row({ audienceRule: corrupt }), SECTORS, true);
    expect(out.rule).toBeNull();
    expect(out.excluded).toHaveLength(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('d1');
    expect(logged).not.toContain('Bia');
  });
});
