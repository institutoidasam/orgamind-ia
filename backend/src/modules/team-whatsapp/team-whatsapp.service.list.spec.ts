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
const sectorRow = {
  id: 's1',
  name: 'Financeiro',
  code: 'FIN',
  members: [
    {
      id: 'u1',
      name: 'Ana',
      email: 'ana@idasam.org',
      phoneE164: PHONE,
      isActive: true,
      shift: 'FIRST' as const,
    },
  ],
};

describe('TeamWhatsappService.targets', () => {
  beforeEach(() => {
    h.repo.listEligibleChannels.mockResolvedValue([channelRow]);
    h.repo.listSectors.mockResolvedValue([sectorRow]);
  });

  it('ADMIN lista todos os setores ativos', async () => {
    h.repo.findActor.mockResolvedValue(ADMIN);
    const out = await h.service.targets('a');
    expect(h.repo.listSectors.mock.calls).toContainEqual([null]);
    expect(teamTargetsResponseSchema.parse(out)).toEqual({
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
  shift: null,
  author: { id: 'm', name: 'Gestor', email: 'gestor@idasam.org' },
  channel: { id: 'c1', name: 'Canal' },
  ...over,
});

const recipient = (over: Partial<TeamRecipientRow>): TeamRecipientRow => ({
  dispatchId: 'd1',
  userId: 'u1',
  userName: 'Bia',
  shift: null,
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
      counts: { queued: 2, sent: 3, failed: 0, skipped: 1 },
      recipients: [],
    });
    expect(out.items[1]).toMatchObject({
      target: { type: 'user', id: 'u1', label: 'Ana' },
      channel: null,
      author: null,
      counts: { queued: 0, sent: 0, failed: 0, skipped: 0 },
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
    shift: 'SECOND',
  }),
  recipient({ userName: 'Ana', status: 'SENT', shift: 'SECOND' }),
  recipient({ userId: 'u4', userName: 'Davi', shift: 'FIRST' }),
];
const listed = (r: {
  userId: string | null;
  name: string;
  shift: TeamRecipientRow['shift'];
  status: TeamRecipientRow['status'];
  reason: string | null;
}) => ({
  userId: r.userId,
  name: r.name,
  shift: r.shift,
  status: r.status,
  reason: r.reason,
});

describe('TeamWhatsappService.listDispatches — destinatários', () => {
  beforeEach(() => h.repo.findActor.mockResolvedValue(ADMIN));

  it('lista todos os destinatários com turno e situação, por nome, sem telefone', async () => {
    h.repo.listDispatches.mockResolvedValue([
      row({ shift: 'SECOND' }),
      row({ id: 'd2' }),
    ]);
    h.repo.listRecipients.mockResolvedValue(recipientRows);
    const res = await h.service.listDispatches('a');
    const out = teamDispatchListResponseSchema.parse(res);
    expect(h.repo.listRecipients.mock.calls).toEqual([[['d1', 'd2']]]);
    expect(out.items[0].target.shift).toBe('SECOND');
    expect(out.items[0].recipients).toEqual([
      listed({
        userId: 'u1',
        name: 'Ana',
        shift: 'SECOND',
        status: 'SENT',
        reason: null,
      }),
      listed({
        userId: null,
        name: 'Bia',
        shift: 'SECOND',
        status: 'FAILED',
        reason: 'evolution.session_closed',
      }),
      listed({
        userId: 'u3',
        name: 'Caio',
        shift: null,
        status: 'SKIPPED',
        reason: 'NO_PHONE',
      }),
      listed({
        userId: 'u4',
        name: 'Davi',
        shift: 'FIRST',
        status: 'QUEUED',
        reason: null,
      }),
    ]);
    expect(out.items[1].recipients).toEqual([]);
    expect(res.items[0]).not.toHaveProperty('issues');
    expect(JSON.stringify(res)).not.toContain('+55');
  });
});
