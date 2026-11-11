import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { Queue } from 'bullmq';
import type { AuditService } from '../../shared/audit/audit.service';
import type { TeamWhatsappSendJob } from '../queue/queue.constants';
import type { TeamActor } from './team-whatsapp.policy';
import type {
  DispatchForActor,
  TeamWhatsappRepository,
} from './team-whatsapp.repository';
import { TeamWhatsappRetryService } from './team-whatsapp-retry.service';
import { teamSendJobId } from './team-whatsapp.service';
import { ADMIN, MANAGER, member, sector } from './team-whatsapp.test-fixtures';

const ALL = { all: true } as const;
const ONE = { recipientIds: ['r1'] };
const QUEUE_DOWN = new Error('redis fora');

let repo: DeepMockProxy<TeamWhatsappRepository>;
const audit = { log: vi.fn() };
let queue: { addBulk: ReturnType<typeof vi.fn>; add: ReturnType<typeof vi.fn> };
let service: TeamWhatsappRetryService;

const dispatchOf = (
  over: Partial<DispatchForActor> = {},
): DispatchForActor => ({
  id: 'd1',
  authorId: MANAGER.id,
  targetType: 'SECTOR',
  targetId: 's1',
  state: 'DISPATCHED',
  sectors: [{ sectorId: 's1' }],
  ...over,
});

function given(actor: TeamActor | null, dispatch: DispatchForActor | null) {
  repo.findActor.mockResolvedValue(actor);
  repo.findDispatchForActor.mockResolvedValue(dispatch);
}

beforeEach(() => {
  repo = mockDeep<TeamWhatsappRepository>();
  audit.log.mockReset();
  queue = { addBulk: vi.fn().mockResolvedValue([]), add: vi.fn() };
  service = new TeamWhatsappRetryService(
    repo,
    audit as unknown as AuditService,
    queue as unknown as Queue<TeamWhatsappSendJob>,
  );
  repo.requeueFailed.mockResolvedValue([{ id: 'r1', manualRetries: 1 }]);
  repo.findSector.mockResolvedValue(sector());
  repo.findTargetUser.mockResolvedValue(member());
});

type AuthCase = [
  string,
  TeamActor | null,
  DispatchForActor | null,
  number,
  string,
];
const OUTSIDER: TeamActor = { ...MANAGER, id: 'o' };
const DENIED: AuthCase[] = [
  [
    'ator sem papel de remetente',
    { ...MANAGER, managedSectorIds: [] },
    dispatchOf(),
    403,
    'team_whatsapp.forbidden',
  ],
  ['ator inexistente', null, dispatchOf(), 403, 'team_whatsapp.forbidden'],
  [
    'OPERATOR em envio de outro autor',
    OUTSIDER,
    dispatchOf(),
    404,
    'team_whatsapp.dispatch_not_found',
  ],
  ['envio inexistente', MANAGER, null, 404, 'team_whatsapp.dispatch_not_found'],
  [
    'gestor autor cujo envio tem setor que ele não gerencia mais',
    MANAGER,
    dispatchOf({ sectors: [{ sectorId: 's1' }, { sectorId: 's2' }] }),
    403,
    'team_whatsapp.forbidden',
  ],
  [
    'gestor autor de envio a setor sem linha de setor',
    MANAGER,
    dispatchOf({ sectors: [] }),
    403,
    'team_whatsapp.forbidden',
  ],
  [
    'alvo pessoa fora do alcance do gestor',
    MANAGER,
    dispatchOf({ targetType: 'USER', targetId: 'u9', sectors: [] }),
    403,
    'team_whatsapp.forbidden',
  ],
];
const ALLOWED: [string, TeamActor, DispatchForActor][] = [
  [
    'ADMIN, envio de outro autor com vários setores',
    ADMIN,
    dispatchOf({
      authorId: 'outro',
      sectors: [{ sectorId: 's1' }, { sectorId: 's2' }],
    }),
  ],
  ['gestor autor, envio a setor que ele gerencia', MANAGER, dispatchOf()],
  [
    'gestor autor, alvo pessoa do seu setor',
    MANAGER,
    dispatchOf({ targetType: 'USER', targetId: 'u1', sectors: [] }),
  ],
  [
    'ADMIN, alvo pessoa ativa',
    ADMIN,
    dispatchOf({ targetType: 'USER', targetId: 'u1', sectors: [] }),
  ],
];

function givenDenied(
  actor: TeamActor | null,
  dispatch: DispatchForActor | null,
) {
  given(actor, dispatch);
  repo.findSector.mockImplementation((id) => Promise.resolve(sector({ id })));
  repo.findTargetUser.mockResolvedValue(
    member({ id: 'u9', sectorId: 's9', sector: { isActive: true } }),
  );
}

function givenDeletedUserTarget(actor: TeamActor): void {
  given(actor, dispatchOf({ targetType: 'USER', targetId: 'u1', sectors: [] }));
  repo.findTargetUser.mockResolvedValue(null);
}

describe('autorização (GC5): nada é lido do envio nem trocado antes dela', () => {
  it.each<AuthCase>(DENIED)('%s → %s', async (...args) => {
    const [, actor, dispatch, status, code] = args;
    givenDenied(actor, dispatch);
    await expect(
      service.retry(actor?.id ?? 'x', 'd1', ONE),
    ).rejects.toMatchObject({ status, code });
    expect(repo.requeueFailed.mock.calls).toHaveLength(0);
    expect(queue.addBulk).not.toHaveBeenCalled();
    expect(audit.log.mock.calls).toHaveLength(0);
  });

  it('alvo pessoa apagada → 403', async () => {
    givenDeletedUserTarget(MANAGER);
    await expect(service.retry('m', 'd1', ONE)).rejects.toMatchObject({
      status: 403,
    });
    expect(repo.requeueFailed.mock.calls).toHaveLength(0);
  });

  it('setor desativado: o gestor não repete (403)', async () => {
    given(MANAGER, dispatchOf());
    repo.findSector.mockResolvedValue(sector({ isActive: false }));
    await expect(service.retry('m', 'd1', ONE)).rejects.toMatchObject({
      status: 403,
    });
    expect(repo.requeueFailed.mock.calls).toHaveLength(0);
  });

  it.each(ALLOWED)('%s → repete', async (_caso, actor, dispatch) => {
    given(actor, dispatch);
    await expect(service.retry(actor.id, 'd1', ONE)).resolves.toEqual({
      requeued: 1,
    });
    expect(repo.requeueFailed.mock.calls).toEqual([['d1', ['r1']]]);
  });

  it('ADMIN com alvo pessoa apagada → 403 (não reenvia a quem saiu)', async () => {
    givenDeletedUserTarget(ADMIN);
    await expect(service.retry('a', 'd1', ALL)).rejects.toMatchObject({
      status: 403,
    });
    expect(repo.requeueFailed.mock.calls).toHaveLength(0);
  });
});

describe('teamSendJobId (D12)', () => {
  it.each<[string, number, string]>([
    ['r1', 0, 'r1'],
    ['r1', 1, 'r1-r1'],
    ['r1', 2, 'r1-r2'],
  ])('(%s, %i) → %s, sem ":"', (id, retries, jobId) => {
    expect(teamSendJobId(id, retries)).toBe(jobId);
    expect(jobId).not.toContain(':');
  });
});

const ALL_BULK_JOBS = [
  { name: 'send', data: { recipientId: 'r1' }, opts: { jobId: 'r1-r1' } },
  { name: 'send', data: { recipientId: 'r2' }, opts: { jobId: 'r2-r2' } },
];

describe('troca e fila', () => {
  beforeEach(() => given(MANAGER, dispatchOf()));

  it('"all" pede a troca de todas as falhas certas; a fila recebe o jobId novo e o mesmo destinatário', async () => {
    repo.requeueFailed.mockResolvedValue([
      { id: 'r1', manualRetries: 1 },
      { id: 'r2', manualRetries: 2 },
    ]);
    await expect(service.retry('m', 'd1', ALL)).resolves.toEqual({
      requeued: 2,
    });
    expect(repo.requeueFailed.mock.calls).toEqual([['d1', 'all']]);
    expect(queue.addBulk).toHaveBeenCalledWith(ALL_BULK_JOBS);
  });

  it('auditoria só com ids e contagem (sem nome, telefone ou texto)', async () => {
    await service.retry('m', 'd1', ONE);
    expect(audit.log.mock.calls).toEqual([
      [
        'team_whatsapp.retry',
        'TeamWhatsappDispatch',
        'd1',
        { actorId: 'm', dispatchId: 'd1', requeued: 1 },
      ],
    ]);
  });

  it('fila fora → markFailed(queue_unavailable) e relança; sem auditoria', async () => {
    queue.addBulk.mockRejectedValue(QUEUE_DOWN);
    await expect(service.retry('m', 'd1', ONE)).rejects.toBe(QUEUE_DOWN);
    expect(repo.markFailed.mock.calls).toEqual([
      [['r1'], 'team_whatsapp.queue_unavailable'],
    ]);
    expect(audit.log.mock.calls).toHaveLength(0);
  });

  it('nada repetível → { requeued: 0 } sem fila e sem auditoria', async () => {
    repo.requeueFailed.mockResolvedValue([]);
    await expect(service.retry('m', 'd1', ALL)).resolves.toEqual({
      requeued: 0,
    });
    expect(queue.addBulk).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(audit.log.mock.calls).toHaveLength(0);
  });
});
