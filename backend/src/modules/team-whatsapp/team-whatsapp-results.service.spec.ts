import { beforeEach, describe, expect, it } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import {
  teamDispatchDetailResponseSchema,
  teamDispatchRecipientPageSchema,
} from '../../schemas/contracts/team-whatsapp.schema';
import type {
  DispatchDetailRow,
  DispatchRecipientRow,
  TeamWhatsappRepository,
} from './team-whatsapp.repository';
import type { TeamActor } from './team-whatsapp.policy';
import { TeamWhatsappResultsService } from './team-whatsapp-results.service';
import { ADMIN, MANAGER, PHONE } from './team-whatsapp.test-fixtures';

const OTHER_AUTHOR = 'outro-autor';
const QUERY = { page: 1, pageSize: 50 };

let repo: DeepMockProxy<TeamWhatsappRepository>;
let service: TeamWhatsappResultsService;

const dispatchOf = (authorId: string | null) => ({
  id: 'd1',
  authorId,
  targetType: 'SECTOR' as const,
  targetId: 's1',
  state: 'DISPATCHED' as const,
  sectors: [{ sectorId: 's1' }],
});

const detailRow = (
  over: Partial<DispatchDetailRow> = {},
): DispatchDetailRow => ({
  id: 'd1',
  targetLabel: 'Financeiro',
  text: 'Reunião às 9h',
  state: 'DISPATCHED',
  createdAt: new Date('2026-11-10T12:00:00.000Z'),
  scheduledFor: null,
  firedAt: null,
  roster: null,
  author: { id: 'm', name: 'Gestor' },
  sectors: [
    { sectorId: 's2', sectorName: 'Vendas' },
    { sectorId: 's1', sectorName: 'Financeiro' },
  ],
  ...over,
});

const recipientRow = (
  over: Partial<DispatchRecipientRow> = {},
): DispatchRecipientRow => ({
  id: 'r1',
  userName: 'Ana',
  sectorName: 'Financeiro',
  levelName: 'Pleno',
  shiftName: '2º turno',
  status: 'QUEUED',
  errorCode: null,
  skipReason: null,
  attempts: 0,
  channel: { name: 'GBR', phoneE164: '+559230001111' },
  acceptedAt: null,
  deliveredAt: null,
  readAt: null,
  repliedAt: null,
  ...over,
});

beforeEach(() => {
  repo = mockDeep<TeamWhatsappRepository>();
  service = new TeamWhatsappResultsService(repo);
  repo.findDispatchDetail.mockResolvedValue(detailRow());
  repo.countByStatus.mockResolvedValue([]);
  repo.channelsByDispatch.mockResolvedValue([]);
  repo.findRecipientUserIds.mockResolvedValue([]);
  repo.listDispatchRecipients.mockResolvedValue({ rows: [], total: 0 });
});

const given = (
  actor: TeamActor | null,
  authorId: string | null | undefined,
) => {
  repo.findActor.mockResolvedValue(actor);
  repo.findDispatchForActor.mockResolvedValue(
    authorId === undefined ? null : dispatchOf(authorId),
  );
};

const CALLS = {
  detail: () => service.detail('x', 'd1'),
  recipients: () => service.recipients('x', 'd1', QUERY),
};

// GC5: o ADMIN vê todos; os demais só os próprios; o resto é 404, nunca 403.
describe.each(['detail', 'recipients'] as const)(
  'TeamWhatsappResultsService.%s — visibilidade (GC5)',
  (method) => {
    it.each<[string, TeamActor, string | null | undefined]>([
      ['ADMIN vê envio de outro autor', ADMIN, OTHER_AUTHOR],
      ['ADMIN vê envio sem autor (apagado)', ADMIN, null],
      ['OPERATOR vê o próprio', MANAGER, MANAGER.id],
    ])('%s → 200', async (_label, actor, authorId) => {
      given(actor, authorId);
      await expect(CALLS[method]()).resolves.toBeDefined();
    });

    it.each<[string, TeamActor, string | null | undefined]>([
      ['OPERATOR, envio de outro autor', MANAGER, OTHER_AUTHOR],
      [
        'SUPERVISOR gestor, envio de outro autor',
        { ...MANAGER, role: 'SUPERVISOR' },
        OTHER_AUTHOR,
      ],
      ['OPERATOR, envio sem autor', MANAGER, null],
      ['ADMIN, envio inexistente', ADMIN, undefined],
      ['OPERATOR, envio inexistente', MANAGER, undefined],
    ])(
      '%s → 404 dispatch_not_found, sem tocar nos dados',
      async (_l, actor, author) => {
        given(actor, author);
        await expect(CALLS[method]()).rejects.toMatchObject({
          code: 'team_whatsapp.dispatch_not_found',
          status: 404,
        });
        expect(repo.findDispatchDetail.mock.calls).toHaveLength(0);
        expect(repo.listDispatchRecipients.mock.calls).toHaveLength(0);
        expect(repo.countByStatus.mock.calls).toHaveLength(0);
      },
    );

    it.each<[string, TeamActor | null]>([
      ['VIEWER', { ...MANAGER, role: 'VIEWER' }],
      ['OPERATOR sem setor gerido', { ...MANAGER, managedSectorIds: [] }],
      ['ator inativo', { ...MANAGER, isActive: false }],
      ['ator sem acesso', { ...MANAGER, hasAccess: false }],
      ['ator inexistente', null],
    ])('%s → 403 forbidden antes de olhar o envio', async (_label, actor) => {
      given(actor, MANAGER.id);
      await expect(CALLS[method]()).rejects.toMatchObject({
        code: 'team_whatsapp.forbidden',
        status: 403,
      });
      expect(repo.findDispatchForActor.mock.calls).toHaveLength(0);
    });
  },
);

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
// Foto anterior à T7 não tem setor nem nível da pessoa: o detalhe devolve null.
const oldPhoto = (p: object) => ({ ...p, sectorName: null, levelName: null });

const TOP_DETAIL = {
  id: 'd1',
  targetLabel: 'Financeiro',
  text: 'Reunião às 9h',
  state: 'DISPATCHED',
  createdAt: '2026-11-10T12:00:00.000Z',
  scheduledFor: null,
  firedAt: null,
  author: { id: 'm', name: 'Gestor' },
  sectors: [
    { id: 's1', name: 'Financeiro' },
    { id: 's2', name: 'Vendas' },
  ],
  counts: {
    queued: 0,
    sent: 0,
    delivered: 2,
    read: 0,
    replied: 4,
    failed: 0,
    uncertain: 1,
    skipped: 0,
    scheduled: 0,
    cancelled: 0,
  },
  channels: [{ name: 'GBR', phoneE164: '+559230001111', count: 7 }],
  leftOut: { unselected: [], off: [] },
};

function primeTopOfScreen(): void {
  repo.countByStatus.mockResolvedValue([
    { dispatchId: 'd1', status: 'DELIVERED', count: 2 },
    { dispatchId: 'd1', status: 'UNCERTAIN', count: 1 },
    { dispatchId: 'd1', status: 'REPLIED', count: 4 },
  ]);
  repo.channelsByDispatch.mockResolvedValue([
    { dispatchId: 'd1', name: 'GBR', phoneE164: '+559230001111', count: 7 },
  ]);
}

function primeLeftOutRoster(): void {
  const withPhone = { phoneE164: PHONE };
  const working = [
    person('Ana'),
    person('Caio', withPhone),
    person('Ex', { userId: null }),
  ];
  const off = [
    person('Davi', dayOff),
    person('Eva', { ...dayOff, reason: 'VACATION', ...withPhone }),
  ];
  repo.findDispatchDetail.mockResolvedValue(
    detailRow({ roster: { working, off } }),
  );
  repo.findRecipientUserIds.mockResolvedValue(['id-Ana', 'id-Davi']);
}

describe('TeamWhatsappResultsService.detail — formato C5', () => {
  beforeEach(() => given(ADMIN, 'm'));

  it('topo da tela: contagens com as 10 chaves, números e setores por nome', async () => {
    primeTopOfScreen();
    const out = await service.detail('a', 'd1');
    expect(teamDispatchDetailResponseSchema.safeParse(out).success).toBe(true);
    expect(out).toEqual(TOP_DETAIL);
  });

  it('leftOut: working e off da foto menos quem é destinatário; sem telefone', async () => {
    primeLeftOutRoster();
    const res = await service.detail('a', 'd1');
    expect(repo.findRecipientUserIds.mock.calls).toEqual([
      ['d1', ['id-Ana', 'id-Caio', 'id-Davi', 'id-Eva']],
    ]);
    expect(res.leftOut.unselected.map((p) => p.name)).toEqual(['Caio', 'Ex']);
    expect(res.leftOut.off).toEqual([
      oldPhoto(person('Eva', { ...dayOff, reason: 'VACATION' })),
    ]);
    expect(JSON.stringify(res)).not.toContain('+55929');
    expect(JSON.stringify(res)).not.toMatch(/"\w*phone\w*":/i);
  });

  it.each([
    ['sem foto', null],
    ['working fora do formato', { working: 'x', off: [] }],
    ['foto antiga sem off', { working: [person('Ana')] }],
    ['lista em vez de objeto', [person('Ana')]],
  ])('foto %s → leftOut vazio', async (_label, roster) => {
    repo.findDispatchDetail.mockResolvedValue(detailRow({ roster }));
    const out = await service.detail('a', 'd1');
    expect(out.leftOut).toEqual({ unselected: [], off: [] });
  });
});

function primeReasonRows(at: Date): void {
  const rows = [
    recipientRow({
      id: 'r1',
      status: 'FAILED',
      errorCode: 'team_whatsapp.channel_disconnected',
      attempts: 2,
    }),
    recipientRow({
      id: 'r2',
      status: 'FAILED',
      errorCode: 'evolution.number_not_on_whatsapp',
    }),
    recipientRow({
      id: 'r3',
      status: 'SKIPPED',
      skipReason: 'NO_PHONE',
      channel: null,
    }),
    recipientRow({ id: 'r4', status: 'REPLIED', repliedAt: at }),
  ];
  repo.listDispatchRecipients.mockResolvedValue({ total: 4, rows });
}

function primeReceiptRows(read: Date, delivered: Date): void {
  const rows = [
    recipientRow({ id: 'r1', status: 'READ', readAt: read }),
    recipientRow({
      id: 'r2',
      status: 'READ',
      readAt: read,
      deliveredAt: delivered,
    }),
  ];
  repo.listDispatchRecipients.mockResolvedValue({ total: 2, rows });
}

describe('TeamWhatsappResultsService.recipients — itens (C5)', () => {
  beforeEach(() => given(ADMIN, 'm'));

  it('repassa status e página ao repositório e ecoa page, pageSize e total', async () => {
    repo.listDispatchRecipients.mockResolvedValue({ rows: [], total: 120 });
    const query = { status: 'FAILED' as const, page: 3, pageSize: 20 };
    await expect(service.recipients('a', 'd1', query)).resolves.toEqual({
      items: [],
      total: 120,
      page: 3,
      pageSize: 20,
    });
    expect(repo.listDispatchRecipients.mock.calls).toEqual([['d1', query]]);
  });

  it('reason = skipReason ?? errorCode; repeatable vem de isRepeatable; datas em ISO', async () => {
    const at = new Date('2026-11-10T12:05:00.000Z');
    primeReasonRows(at);
    const out = await service.recipients('a', 'd1', QUERY);
    expect(teamDispatchRecipientPageSchema.safeParse(out).success).toBe(true);
    expect(
      out.items.map((i) => [i.id, i.reason, i.repeatable, i.channel?.name]),
    ).toEqual([
      ['r1', 'team_whatsapp.channel_disconnected', true, 'GBR'],
      ['r2', 'evolution.number_not_on_whatsapp', false, 'GBR'],
      ['r3', 'NO_PHONE', false, undefined],
      ['r4', null, false, 'GBR'],
    ]);
    expect(out.items[0]).toMatchObject({
      userName: 'Ana',
      sectorName: 'Financeiro',
      levelName: 'Pleno',
      shiftName: '2º turno',
      attempts: 2,
      channel: { name: 'GBR', phoneE164: '+559230001111' },
    });
    expect(out.items[3].repliedAt).toBe('2026-11-10T12:05:00.000Z');
  });

  it('deliveredAt cai em readAt quando o recibo de entrega chegou depois do de leitura', async () => {
    const read = new Date('2026-11-10T12:06:00.000Z');
    const delivered = new Date('2026-11-10T12:04:00.000Z');
    primeReceiptRows(read, delivered);
    const { items } = await service.recipients('a', 'd1', QUERY);
    expect(items.map((i) => [i.deliveredAt, i.readAt])).toEqual([
      [read.toISOString(), read.toISOString()],
      [delivered.toISOString(), read.toISOString()],
    ]);
  });
});
