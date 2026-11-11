import { describe, expect, it } from 'vitest';
import {
  dispatchDetailSchema, dispatchListSchema, dispatchRecipientPageSchema, retryResultSchema, teamPersonRouteSchema,
  teamRosterSchema,
} from './schemas';

const base = {
  sectors: [],
  createdAt: '2026-10-21T12:00:00.000Z',
  author: null,
  channels: [],
  rosterDate: '2026-10-21',
  firedAt: null,
};
const ZERO = {
  queued: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, uncertain: 0, skipped: 0, scheduled: 0, cancelled: 0,
};
const page = { total: 2, page: 1, pageSize: 20 };
const shift = { id: 'sh1', name: 'Noite', startTime: '22:00', endTime: '6h' };
const target = (label: string) => ({ type: 'sector', id: 's1', label, shift });

describe('dispatchListSchema', () => {
  it('lê a página com um envio agendado e um cancelado, os números usados e o total', () => {
    const parsed = dispatchListSchema.parse({
      items: [
        {
          ...base, id: 'd1', target: target('Produção · Noite · 21/10'), state: 'SCHEDULED',
          scheduledFor: '2026-10-22T02:00:00.000Z', counts: { ...ZERO, scheduled: 1 },
        },
        {
          ...base, id: 'd2', target: target('RH, TI · Noite · 20/10'), state: 'CANCELLED', scheduledFor: null,
          sectors: [{ id: 'rh', name: 'RH' }, { id: 'ti', name: 'TI' }],
          channels: [{ name: 'GoZap Principal', phoneE164: '+5592999990000', count: 2 }, { name: null, phoneE164: null, count: 1 }],
          counts: { ...ZERO, skipped: 1, cancelled: 1, read: 1 },
        },
      ],
      ...page,
    });
    expect(parsed.items.map((i) => i.state)).toEqual(['SCHEDULED', 'CANCELLED']);
    expect(parsed.items[1].channels).toHaveLength(2);
    expect(parsed.items[1].counts).toMatchObject({ read: 1, cancelled: 1 });
    expect(parsed.total).toBe(2);
  });

  it('rejeita o item no formato antigo (sem channels e com contadores de menos)', () => {
    expect(() => dispatchListSchema.parse({
      items: [{
        ...base, channels: undefined, id: 'd1', target: target('Produção'), state: 'DISPATCHED', scheduledFor: null,
        counts: { queued: 0, sent: 1, failed: 0, skipped: 0, scheduled: 0, cancelled: 0 },
      }],
      ...page,
    })).toThrow();
  });
});

describe('número da área na prévia (C2)', () => {
  const live = (state: string) => ({ state, checkedAt: '2026-11-10T18:05:00.000Z' });
  const channel = { id: 'ch1', name: 'GoZap Principal', phoneE164: null, provider: 'GOZAP', live: live('unknown') };

  it('lê o número de cada área (ou null) e o estado ao vivo da escala', () => {
    const roster = teamRosterSchema.parse({
      date: '2026-11-10', shiftStarts: [],
      sectors: [
        { sectorId: 's1', name: 'Logística', channel, members: [] },
        { sectorId: 's2', name: 'Expedição', channel: null, members: [] },
      ],
    });
    expect(roster.sectors.map((s) => s.channel?.live.state ?? null)).toEqual(['unknown', null]);
  });

  it('lê a rota da pessoa sem área (setor e número nulos) e rejeita estado desconhecido', () => {
    expect(teamPersonRouteSchema.parse({ userId: 'u1', sector: null, channel: null }).sector).toBeNull();
    expect(() => teamPersonRouteSchema.parse({
      userId: 'u1', sector: { id: 's1', name: 'Logística' }, channel: { ...channel, live: live('desconhecido') },
    })).toThrow();
  });
});

describe('resultado do envio (C5, C6)', () => {
  const person = {
    userId: 'u1', name: 'Ana', jobTitle: 'Analista', shiftName: 'Noite', reason: null, sectorName: 'TI', levelName: null,
  };
  const detailWith = (leftOut: unknown) => ({
    id: 'd1', targetLabel: 'TI', text: 'Oi', state: 'DISPATCHED', createdAt: '2026-10-21T12:00:00.000Z',
    scheduledFor: null, firedAt: null, author: { id: 'a1', name: 'Ada' }, sectors: [{ id: 's1', name: 'TI' }],
    counts: ZERO, channels: [{ name: null, phoneE164: null, count: 1 }], leftOut,
  });

  it('lê o detalhe com quem ficou de fora no formato da pessoa do roster do back', () => {
    const off = { ...person, userId: null, name: 'Bia', reason: 'VACATION' };
    const detail = dispatchDetailSchema.parse(detailWith({ unselected: [person], off: [off] }));
    expect(detail.leftOut).toEqual({ unselected: [person], off: [off] });
  });

  it('rejeita pessoa de fora sem reason (null é obrigatório) ou com motivo desconhecido', () => {
    const semReason: Partial<typeof person> = { ...person };
    delete semReason.reason;
    expect(() => dispatchDetailSchema.parse(detailWith({ unselected: [semReason], off: [] }))).toThrow();
    expect(() => dispatchDetailSchema.parse(detailWith({ unselected: [], off: [{ ...person, reason: 'SICK' }] }))).toThrow();
  });

  it('lê a página de destinatários com o número, as tentativas e o repeatable do servidor', () => {
    const item = {
      id: 'r1', userName: 'Ana', sectorName: 'TI', levelName: null, shiftName: null, status: 'FAILED',
      reason: 'team_whatsapp.channel_disconnected', attempts: 3, channel: { name: 'GoZap', phoneE164: '+5592999990000' },
      acceptedAt: null, deliveredAt: null, readAt: null, repliedAt: null, repeatable: true,
    };
    const parsed = dispatchRecipientPageSchema.parse({ items: [item, { ...item, id: 'r2', channel: null }], ...page });
    expect(parsed.items.map((i) => i.repeatable)).toEqual([true, true]);
    expect(parsed.items[1].channel).toBeNull();
    expect(() => dispatchRecipientPageSchema.parse({ items: [{ ...item, status: 'DONE' }], ...page })).toThrow();
  });

  it('lê o retorno do retry', () => {
    expect(retryResultSchema.parse({ requeued: 0 })).toEqual({ requeued: 0 });
  });
});
