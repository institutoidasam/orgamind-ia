import { describe, it, expect, beforeEach } from 'vitest';
import type { TeamDispatchRow } from './team-whatsapp.repository';
import {
  teamDispatchListResponseSchema,
  teamTargetsResponseSchema,
} from '../../schemas/contracts/team-whatsapp.schema';
import {
  ADMIN,
  MANAGER,
  SHIFT_SECOND,
  createHarness,
  type Harness,
} from './team-whatsapp.test-fixtures';

const PAGE = { page: 1, pageSize: 20 };
const paged = (rows: TeamDispatchRow[]) => ({ rows, total: rows.length });

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
  state: 'DISPATCHED',
  scheduledFor: null,
  firedAt: null,
  author: { id: 'm', name: 'Gestor', email: 'gestor@idasam.org' },
  sectors: [{ sectorId: 's1', sectorName: 'Financeiro' }],
  ...over,
});

const ZERO = {
  queued: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  replied: 0,
  failed: 0,
  uncertain: 0,
  skipped: 0,
  scheduled: 0,
  cancelled: 0,
};

describe('TeamWhatsappService.listDispatches — escopo', () => {
  beforeEach(() => h.repo.listDispatches.mockResolvedValue(paged([])));

  it('ADMIN vê todos os envios', async () => {
    h.repo.findActor.mockResolvedValue(ADMIN);
    await expect(h.service.listDispatches('a', PAGE)).resolves.toEqual({
      items: [],
      total: 0,
      ...PAGE,
    });
    expect(h.repo.listDispatches.mock.calls).toContainEqual([null, PAGE]);
  });

  it('repassa a página ao repositório e devolve total, page e pageSize (D13)', async () => {
    h.repo.findActor.mockResolvedValue(ADMIN);
    h.repo.listDispatches.mockResolvedValue({ rows: [], total: 41 });
    const page = { page: 3, pageSize: 10 };
    await expect(h.service.listDispatches('a', page)).resolves.toEqual({
      items: [],
      total: 41,
      ...page,
    });
    expect(h.repo.listDispatches.mock.calls).toContainEqual([null, page]);
  });

  it('gestor vê só os próprios', async () => {
    h.repo.findActor.mockResolvedValue(MANAGER);
    await h.service.listDispatches('m', PAGE);
    expect(h.repo.listDispatches.mock.calls).toContainEqual(['m', PAGE]);
  });

  it('quem não é ADMIN nem gestor recebe 403', async () => {
    h.repo.findActor.mockResolvedValue({ ...MANAGER, managedSectorIds: [] });
    await expect(h.service.listDispatches('x', PAGE)).rejects.toMatchObject({
      code: 'team_whatsapp.forbidden',
      status: 403,
    });
    expect(h.repo.listDispatches.mock.calls).toHaveLength(0);
  });
});

const FIRST_ITEM = {
  id: 'd1',
  createdAt: '2026-10-16T12:00:00.000Z',
  author: { id: 'm', name: 'Gestor', email: 'gestor@idasam.org' },
  target: { type: 'sector', id: 's1', label: 'Financeiro', shift: null },
  sectors: [{ id: 's1', name: 'Financeiro' }],
  channels: [
    { name: 'GBR', phoneE164: '+559230001111', count: 20 },
    { name: null, phoneE164: null, count: 8 },
  ],
  counts: {
    queued: 2,
    sent: 3,
    delivered: 4,
    read: 5,
    replied: 6,
    failed: 0,
    uncertain: 7,
    skipped: 1,
    scheduled: 0,
    cancelled: 0,
  },
  rosterDate: null,
  state: 'DISPATCHED',
  scheduledFor: null,
  firedAt: null,
};

// Dois envios (d1 setor, d2 pessoa sem autor); contagens e números só do d1.
function primeItems(): void {
  h.repo.listDispatches.mockResolvedValue(
    paged([
      row(),
      row({
        id: 'd2',
        targetType: 'USER',
        targetId: 'u1',
        targetLabel: 'Ana',
        author: null,
        sectors: [],
      }),
    ]),
  );
  h.repo.countByStatus.mockResolvedValue([
    { dispatchId: 'd1', status: 'QUEUED', count: 2 },
    { dispatchId: 'd1', status: 'SKIPPED', count: 1 },
    { dispatchId: 'd1', status: 'SENT', count: 3 },
    { dispatchId: 'd1', status: 'DELIVERED', count: 4 },
    { dispatchId: 'd1', status: 'READ', count: 5 },
    { dispatchId: 'd1', status: 'REPLIED', count: 6 },
    { dispatchId: 'd1', status: 'UNCERTAIN', count: 7 },
  ]);
  h.repo.channelsByDispatch.mockResolvedValue([
    { dispatchId: 'd1', name: 'GBR', phoneE164: '+559230001111', count: 20 },
    { dispatchId: 'd1', name: null, phoneE164: null, count: 8 },
  ]);
}

describe('TeamWhatsappService.listDispatches — itens (C5)', () => {
  beforeEach(() => h.repo.findActor.mockResolvedValue(ADMIN));

  it('item sem recipients, unselected, off e channel; com channels e counts de 10 chaves', async () => {
    primeItems();
    const out = await h.service.listDispatches('a', PAGE);
    expect(teamDispatchListResponseSchema.safeParse(out).success).toBe(true);
    expect(h.repo.countByStatus.mock.calls).toContainEqual([['d1', 'd2']]);
    expect(h.repo.channelsByDispatch.mock.calls).toContainEqual([['d1', 'd2']]);
    expect(out.items[0]).toEqual(FIRST_ITEM);
    expect(out.items[1]).toMatchObject({
      target: { type: 'user', id: 'u1', label: 'Ana' },
      sectors: [],
      channels: [],
      author: null,
      counts: ZERO,
    });
    // Só o telefone do número (empresa) aparece; nenhuma pessoa (GC8).
    expect(JSON.stringify(out)).toContain('+559230001111');
  });
});

function primeScheduledRows(): void {
  h.repo.listDispatches.mockResolvedValue(
    paged([
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
    ]),
  );
  h.repo.countByStatus.mockResolvedValue([
    { dispatchId: 'd1', status: 'SCHEDULED', count: 2 },
    { dispatchId: 'd1', status: 'CANCELLED', count: 1 },
    { dispatchId: 'd2', status: 'SENT', count: 1 },
  ]);
}

describe('TeamWhatsappService.listDispatches — agendamento e turno', () => {
  beforeEach(() => h.repo.findActor.mockResolvedValue(ADMIN));

  it('state/scheduledFor/firedAt e counts scheduled/cancelled', async () => {
    primeScheduledRows();
    const out = teamDispatchListResponseSchema.parse(
      await h.service.listDispatches('a', PAGE),
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

  it('target.shift vem do snapshot gravado (todos os turnos → null) e rosterDate em YYYY-MM-DD', async () => {
    h.repo.listDispatches.mockResolvedValue(
      paged([
        row({
          shiftId: 'shift_second',
          shiftName: '2º turno',
          shiftStartTime: '14:00',
          shiftEndTime: '22:00',
          rosterDate: new Date('2026-10-21T00:00:00.000Z'),
        }),
        row({ id: 'd2' }),
      ]),
    );
    const out = teamDispatchListResponseSchema.parse(
      await h.service.listDispatches('a', PAGE),
    );
    expect(out.items.map((i) => i.target.shift)).toEqual([SHIFT_SECOND, null]);
    expect(out.items.map((i) => i.rosterDate)).toEqual(['2026-10-21', null]);
  });
});
