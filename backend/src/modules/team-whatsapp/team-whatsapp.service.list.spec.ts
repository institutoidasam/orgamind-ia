import { describe, it, expect, beforeEach } from 'vitest';
import type {
  TeamDispatchRow,
  TeamRecipientRow,
} from './team-whatsapp.repository';
import {
  teamDispatchListResponseSchema,
  teamTargetsResponseSchema,
} from '../../schemas/contracts/team-whatsapp.schema';
import {
  ADMIN,
  MANAGER,
  PHONE,
  SHIFT_SECOND,
  createHarness,
  type Harness,
} from './team-whatsapp.test-fixtures';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});

const channelRow = {
  id: 'c1',
  name: 'Canal',
  phoneE164: '+5592900000000',
  provider: 'GOZAP' as const,
  connectionEvents: [{ state: 'open' }],
};
const channelOut = {
  id: 'c1',
  name: 'Canal',
  phoneE164: '+5592900000000',
  provider: 'GOZAP' as const,
  connectionState: 'open' as const,
};
// C6: o setor dos alvos não traz mais membros (vêm do GET roster, por data).
const sectorRow = { id: 's1', name: 'Financeiro', code: 'FIN' };

describe('TeamWhatsappService.targets', () => {
  beforeEach(() => {
    h.repo.listEligibleChannels.mockResolvedValue([channelRow]);
    h.repo.listSectors.mockResolvedValue([sectorRow]);
  });

  it('ADMIN lista todos os setores ativos', async () => {
    h.repo.findActor.mockResolvedValue(ADMIN);
    const out = await h.service.targets('a');
    expect(h.repo.listSectors.mock.calls).toContainEqual([null]);
    expect(teamTargetsResponseSchema.parse(out)).toMatchObject({
      channels: [channelOut],
      sectors: [sectorRow],
    });
  });

  it('gestor lista só os setores que gerencia', async () => {
    h.repo.findActor.mockResolvedValue(MANAGER);
    await h.service.targets('m');
    expect(h.repo.listSectors.mock.calls).toContainEqual([['s1']]);
  });

  it('descarta canal de provedor fora da lista (defesa além do filtro do repositório)', async () => {
    h.repo.findActor.mockResolvedValue(ADMIN);
    h.repo.listEligibleChannels.mockResolvedValue([
      channelRow,
      { ...channelRow, id: 'c2', provider: 'META' },
    ]);
    const out = await h.service.targets('a');
    expect(out.channels.map((c) => c.id)).toEqual(['c1']);
  });
});

describe('TeamWhatsappService.targets — connectionState e acesso', () => {
  beforeEach(() => {
    h.repo.listEligibleChannels.mockResolvedValue([channelRow]);
    h.repo.listSectors.mockResolvedValue([sectorRow]);
  });

  it.each([
    ['open', [{ state: 'open' }], 'open'],
    ['connecting', [{ state: 'connecting' }], 'connecting'],
    ['sem evento', [], null],
    ['estado fora do enum', [{ state: 'qrcode' }], null],
  ])(
    'connectionState do canal: %s',
    async (_label, connectionEvents, expected) => {
      h.repo.findActor.mockResolvedValue(ADMIN);
      h.repo.listEligibleChannels.mockResolvedValue([
        { ...channelRow, connectionEvents },
      ]);
      const out = teamTargetsResponseSchema.parse(await h.service.targets('a'));
      expect(out.channels[0].connectionState).toBe(expected);
      expect(out.channels[0]).not.toHaveProperty('connectionEvents');
    },
  );

  it.each([
    null,
    { ...MANAGER, managedSectorIds: [] },
    { ...MANAGER, role: 'VIEWER' as const },
  ])('quem não é ADMIN nem gestor recebe 403 #%#', async (actor) => {
    h.repo.findActor.mockResolvedValue(actor);
    await expect(h.service.targets('x')).rejects.toMatchObject({
      code: 'team_whatsapp.forbidden',
      status: 403,
    });
    expect(h.repo.listSectors.mock.calls).toHaveLength(0);
    expect(h.repo.listEligibleChannels.mock.calls).toHaveLength(0);
  });
});

const row = (over: Partial<TeamDispatchRow> = {}): TeamDispatchRow => ({
  id: 'd1',
  createdAt: new Date('2026-10-16T12:00:00.000Z'),
  targetType: 'SECTOR',
  targetId: 's1',
  targetLabel: 'Financeiro',
  shiftId: null,
  shiftName: null,
  shiftStartTime: null,
  shiftEndTime: null,
  rosterDate: null,
  includeOff: false,
  roster: null,
  state: 'DISPATCHED',
  scheduledFor: null,
  firedAt: null,
  author: { id: 'm', name: 'Gestor', email: 'gestor@idasam.org' },
  channel: { id: 'c1', name: 'Canal' },
  ...over,
});

const ZERO = {
  queued: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
  scheduled: 0,
  cancelled: 0,
};

const recipient = (over: Partial<TeamRecipientRow>): TeamRecipientRow => ({
  dispatchId: 'd1',
  userId: 'u1',
  userName: 'Bia',
  shiftName: null,
  status: 'QUEUED',
  errorCode: null,
  skipReason: null,
  ...over,
});

describe('TeamWhatsappService.listDispatches — escopo', () => {
  beforeEach(() => h.repo.listDispatches.mockResolvedValue([]));

  it('ADMIN vê todos os envios', async () => {
    h.repo.findActor.mockResolvedValue(ADMIN);
    await expect(h.service.listDispatches('a')).resolves.toEqual({ items: [] });
    expect(h.repo.listDispatches.mock.calls).toContainEqual([null]);
  });

  it('gestor vê só os próprios', async () => {
    h.repo.findActor.mockResolvedValue(MANAGER);
    await h.service.listDispatches('m');
    expect(h.repo.listDispatches.mock.calls).toContainEqual(['m']);
  });

  it('quem não é ADMIN nem gestor recebe 403', async () => {
    h.repo.findActor.mockResolvedValue({ ...MANAGER, managedSectorIds: [] });
    await expect(h.service.listDispatches('x')).rejects.toMatchObject({
      code: 'team_whatsapp.forbidden',
      status: 403,
    });
    expect(h.repo.listDispatches.mock.calls).toHaveLength(0);
  });
});

describe('TeamWhatsappService.listDispatches — itens', () => {
  beforeEach(() => h.repo.findActor.mockResolvedValue(ADMIN));

  it('monta contagens com zeros, tipo em minúsculas, canal e autor removidos como null', async () => {
    h.repo.listDispatches.mockResolvedValue([
      row(),
      row({
        id: 'd2',
        targetType: 'USER',
        targetId: 'u1',
        targetLabel: 'Ana',
        channel: null,
        author: null,
      }),
    ]);
    h.repo.countByStatus.mockResolvedValue([
      { dispatchId: 'd1', status: 'QUEUED', count: 2 },
      { dispatchId: 'd1', status: 'SKIPPED', count: 1 },
      { dispatchId: 'd1', status: 'SENT', count: 3 },
    ]);
    const out = teamDispatchListResponseSchema.parse(
      await h.service.listDispatches('a'),
    );
    expect(h.repo.countByStatus.mock.calls).toContainEqual([['d1', 'd2']]);
    expect(out.items[0]).toEqual({
      id: 'd1',
      createdAt: '2026-10-16T12:00:00.000Z',
      author: { id: 'm', name: 'Gestor', email: 'gestor@idasam.org' },
      target: { type: 'sector', id: 's1', label: 'Financeiro', shift: null },
      channel: { id: 'c1', name: 'Canal' },
      counts: { ...ZERO, queued: 2, sent: 3, skipped: 1 },
      recipients: [],
      rosterDate: null,
      state: 'DISPATCHED',
      scheduledFor: null,
      firedAt: null,
      unselected: [],
      off: [],
    });
    expect(out.items[1]).toMatchObject({
      target: { type: 'user', id: 'u1', label: 'Ana' },
      channel: null,
      author: null,
      counts: ZERO,
    });
  });
});

describe('TeamWhatsappService.listDispatches — agendamento', () => {
  beforeEach(() => h.repo.findActor.mockResolvedValue(ADMIN));

  it('state/scheduledFor/firedAt e counts scheduled/cancelled', async () => {
    h.repo.listDispatches.mockResolvedValue([
      row({
        state: 'SCHEDULED',
        scheduledFor: new Date('2026-10-22T02:00:00.000Z'),
      }),
      row({
        id: 'd2',
        state: 'DISPATCHED',
        scheduledFor: new Date('2026-10-21T10:00:00.000Z'),
        firedAt: new Date('2026-10-21T10:00:30.000Z'),
      }),
    ]);
    h.repo.countByStatus.mockResolvedValue([
      { dispatchId: 'd1', status: 'SCHEDULED', count: 2 },
      { dispatchId: 'd1', status: 'CANCELLED', count: 1 },
      { dispatchId: 'd2', status: 'SENT', count: 1 },
    ]);
    const out = teamDispatchListResponseSchema.parse(
      await h.service.listDispatches('a'),
    );
    expect(out.items[0]).toMatchObject({
      state: 'SCHEDULED',
      scheduledFor: '2026-10-22T02:00:00.000Z',
      firedAt: null,
      counts: { ...ZERO, scheduled: 2, cancelled: 1 },
    });
    expect(out.items[1]).toMatchObject({
      state: 'DISPATCHED',
      scheduledFor: '2026-10-21T10:00:00.000Z',
      firedAt: '2026-10-21T10:00:30.000Z',
      counts: { ...ZERO, sent: 1 },
    });
  });
});

// Fora de ordem e com os quatro status; Bia teve o usuário apagado (userId null).
const recipientRows: TeamRecipientRow[] = [
  recipient({
    userId: 'u3',
    userName: 'Caio',
    status: 'SKIPPED',
    skipReason: 'NO_PHONE',
  }),
  recipient({
    userId: null,
    userName: 'Bia',
    status: 'FAILED',
    errorCode: 'evolution.session_closed',
    shiftName: '2º turno',
  }),
  recipient({ userName: 'Ana', status: 'SENT', shiftName: '2º turno' }),
  recipient({ userId: 'u4', userName: 'Davi', shiftName: '1º turno' }),
];
const listed = (r: {
  userId: string | null;
  name: string;
  shiftName: string | null;
  status: TeamRecipientRow['status'];
  reason: string | null;
}) => ({
  userId: r.userId,
  name: r.name,
  shiftName: r.shiftName,
  status: r.status,
  reason: r.reason,
});

describe('TeamWhatsappService.listDispatches — destinatários', () => {
  beforeEach(() => h.repo.findActor.mockResolvedValue(ADMIN));

  it('recipients[].shiftName, por nome, e nenhuma chave de telefone', async () => {
    h.repo.listDispatches.mockResolvedValue([row(), row({ id: 'd2' })]);
    h.repo.listRecipients.mockResolvedValue(recipientRows);
    const res = await h.service.listDispatches('a');
    const out = teamDispatchListResponseSchema.parse(res);
    expect(h.repo.listRecipients.mock.calls).toEqual([[['d1', 'd2']]]);
    expect(out.items[0].recipients).toEqual([
      listed({
        userId: 'u1',
        name: 'Ana',
        shiftName: '2º turno',
        status: 'SENT',
        reason: null,
      }),
      listed({
        userId: null,
        name: 'Bia',
        shiftName: '2º turno',
        status: 'FAILED',
        reason: 'evolution.session_closed',
      }),
      listed({
        userId: 'u3',
        name: 'Caio',
        shiftName: null,
        status: 'SKIPPED',
        reason: 'NO_PHONE',
      }),
      listed({
        userId: 'u4',
        name: 'Davi',
        shiftName: '1º turno',
        status: 'QUEUED',
        reason: null,
      }),
    ]);
    expect(out.items[1].recipients).toEqual([]);
    expect(res.items[0]).not.toHaveProperty('issues');
    expect(JSON.stringify(res)).not.toContain('+55');
    // Nenhuma chave de telefone (o valor NO_PHONE do motivo é permitido).
    expect(JSON.stringify(res)).not.toMatch(/"\w*phone\w*":/i);
  });
});

describe('TeamWhatsappService.listDispatches — snapshot do turno', () => {
  beforeEach(() => h.repo.findActor.mockResolvedValue(ADMIN));

  it('target.shift vem do snapshot gravado; todos os turnos → null', async () => {
    h.repo.listDispatches.mockResolvedValue([
      row({
        shiftId: 'shift_second',
        shiftName: '2º turno',
        shiftStartTime: '14:00',
        shiftEndTime: '22:00',
      }),
      row({ id: 'd2' }),
    ]);
    const out = teamDispatchListResponseSchema.parse(
      await h.service.listDispatches('a'),
    );
    expect(out.items.map((i) => i.target.shift)).toEqual([SHIFT_SECOND, null]);
  });
});

// Pessoa da foto da escala (C8); `over` sobrescreve qualquer campo.
const person = (name: string, over: Record<string, unknown> = {}) => ({
  userId: `id-${name}`,
  name,
  jobTitle: null,
  shiftName: '2º turno',
  reason: null,
  ...over,
});
const dayOff = { shiftName: null, reason: 'DAY_OFF' };

describe('TeamWhatsappService.listDispatches — foto da escala: grupos', () => {
  beforeEach(() => h.repo.findActor.mockResolvedValue(ADMIN));

  it('unselected = foto.working − destinatários; off = foto.off − destinatários', async () => {
    const working = [
      person('Ana'),
      person('Caio'),
      person('Ex', { userId: null }),
    ];
    const off = [
      person('Davi', dayOff),
      person('Eva', { ...dayOff, reason: 'VACATION' }),
    ];
    h.repo.listDispatches.mockResolvedValue([
      row({ roster: { working, off } }),
    ]);
    h.repo.listRecipients.mockResolvedValue([
      recipient({ userId: 'id-Ana', userName: 'Ana' }),
      recipient({ userId: 'id-Davi', userName: 'Davi' }),
    ]);
    const out = teamDispatchListResponseSchema.parse(
      await h.service.listDispatches('a'),
    );
    expect(out.items[0].unselected).toEqual([working[1], working[2]]);
    expect(out.items[0].off).toEqual([off[1]]);
  });

  it.each([
    ['sem foto', null],
    ['working fora do formato', { working: 'x', off: [] }],
    ['sem off', { working: [person('Ana')] }],
    ['pessoa sem nome', { working: [person('Ana', { name: 1 })], off: [] }],
    ['lista em vez de objeto', [person('Ana')]],
  ])(
    'envio sem foto ou com foto fora do formato → unselected e off vazios: %s',
    async (_label, roster) => {
      h.repo.listDispatches.mockResolvedValue([row({ roster })]);
      const out = teamDispatchListResponseSchema.parse(
        await h.service.listDispatches('a'),
      );
      expect(out.items[0]).toMatchObject({ unselected: [], off: [] });
    },
  );
});

describe('TeamWhatsappService.listDispatches — foto da escala: data e telefone', () => {
  beforeEach(() => h.repo.findActor.mockResolvedValue(ADMIN));

  it("rosterDate em 'YYYY-MM-DD'", async () => {
    h.repo.listDispatches.mockResolvedValue([
      row({ rosterDate: new Date('2026-10-21T00:00:00.000Z') }),
      row({ id: 'd2' }),
    ]);
    const out = teamDispatchListResponseSchema.parse(
      await h.service.listDispatches('a'),
    );
    expect(out.items.map((i) => i.rosterDate)).toEqual(['2026-10-21', null]);
  });

  it('nenhuma chave de telefone em unselected/off', async () => {
    const withPhone = { phoneE164: PHONE, contact: { phoneE164: PHONE } };
    const roster = {
      working: [person('Caio', withPhone)],
      off: [person('Eva', { ...dayOff, ...withPhone })],
    };
    h.repo.listDispatches.mockResolvedValue([row({ roster })]);
    const res = await h.service.listDispatches('a');
    expect(res.items[0].unselected.map((p) => p.name)).toEqual(['Caio']);
    expect(res.items[0].off.map((p) => p.name)).toEqual(['Eva']);
    expect(JSON.stringify(res)).not.toContain('+55');
    expect(JSON.stringify(res)).not.toMatch(/"\w*phone\w*":/i);
  });
});
