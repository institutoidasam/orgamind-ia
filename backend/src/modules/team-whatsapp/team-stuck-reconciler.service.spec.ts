import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { mockDeep } from 'vitest-mock-extended';
import type { AuditService } from '../../shared/audit/audit.service';
import type { StuckCandidate, StuckMessage } from './stuck-recipients';
import type { TeamStuckRecipientsRepository } from './team-stuck-recipients.repository';
import {
  TeamStuckReconcilerService,
  type StuckCounts,
} from './team-stuck-reconciler.service';

const NOW = new Date('2026-11-20T15:00:00.000Z');
const ZERO: StuckCounts = {
  queueLost: 0,
  missing: 0,
  sent: 0,
  failed: 0,
  uncertain: 0,
};
const QUEUE_LOST = { kind: 'queueLost', cancelMessage: false };

/**
 * Estado do job no BullMQ (string); `Error` = `getState` lança; `getJobError` =
 * o próprio `getJob` lança (Redis fora); id ausente do mapa = sem job.
 */
type JobFake = string | Error | { getJobError: Error };

function candidate(
  id: string,
  over: Partial<StuckCandidate> = {},
): StuckCandidate {
  return { id, dispatchId: 'd1', messageId: null, manualRetries: 0, ...over };
}

/** Fila falsa: só `getJob` responde; `add`/`addBulk` falham o teste (GH2). */
function fakeQueue(jobs: Record<string, JobFake>, calls: string[]) {
  const forbidden = () => {
    throw new Error('o verificador nunca enfileira');
  };
  const getJob = vi.fn((jobId: string) => {
    calls.push(`getJob:${jobId}`);
    const entry = jobs[jobId];
    if (entry === undefined) return Promise.resolve(undefined);
    if (typeof entry === 'object' && 'getJobError' in entry)
      return Promise.reject(entry.getJobError);
    const getState = () => {
      calls.push(`getState:${jobId}`);
      return entry instanceof Error
        ? Promise.reject(entry)
        : Promise.resolve(entry);
    };
    return Promise.resolve({ getState });
  });
  return { getJob, add: vi.fn(forbidden), addBulk: vi.fn(forbidden) };
}

function setup(
  candidates: StuckCandidate[],
  jobs: Record<string, JobFake> = {},
  messages: Record<string, StuckMessage> = {},
) {
  const calls: string[] = [];
  const repo = mockDeep<TeamStuckRecipientsRepository>();
  repo.findCandidates.mockResolvedValue(candidates);
  repo.loadMessage.mockImplementation((id) => {
    calls.push(`loadMessage:${id}`);
    return Promise.resolve(messages[id] ?? null);
  });
  repo.settle.mockImplementation((c) => {
    calls.push(`settle:${c.id}`);
    return Promise.resolve(true);
  });
  const audit = mockDeep<AuditService>();
  const chat = {
    isRedispatchableFailure: (code: string | null) =>
      code !== null && !code.endsWith('.timeout'),
  };
  const queue = fakeQueue(jobs, calls);
  const service = new TeamStuckReconcilerService(
    repo,
    chat as never,
    audit,
    queue as never,
  );
  return { service, repo, audit, queue, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TeamStuckReconcilerService.reconcile — job perdido (DH5)', () => {
  it('job ausente — perdido; job completed, failed ou unknown também', async () => {
    const all = ['r1', 'r2', 'r3', 'r4'].map((id) => candidate(id));
    const { service, repo } = setup(all, {
      r2: 'completed',
      r3: 'failed',
      r4: 'unknown',
    });

    const cycle = await service.reconcile(NOW);

    expect(repo.findCandidates.mock.calls).toEqual([[NOW]]);
    expect(repo.settle.mock.calls).toEqual(
      all.map((c) => [c, QUEUE_LOST, NOW]),
    );
    expect(cycle).toEqual({
      checked: 4,
      alive: 0,
      lost: 4,
      counts: { ...ZERO, queueLost: 4 },
    });
  });

  it('consulta o job pelo teamSendJobId com o manualRetries lido', async () => {
    const { service, queue } = setup([
      candidate('r1', { manualRetries: 2 }),
      candidate('r2'),
    ]);

    await service.reconcile(NOW);

    expect(queue.getJob.mock.calls).toEqual([['r1-r2'], ['r2']]);
  });
});

describe('TeamStuckReconcilerService.reconcile — job vivo não é tocado', () => {
  it('aceite 3: job waiting, delayed, active ou prioritized há mais de 30 min — não toca', async () => {
    const states = [
      'waiting',
      'delayed',
      'active',
      'prioritized',
      'waiting-children',
    ];
    const jobs = Object.fromEntries(states.map((s, i) => [`r${i}`, s]));
    const all = states.map((_, i) => candidate(`r${i}`, { messageId: 'm' }));
    const { service, repo } = setup(all, jobs);

    const cycle = await service.reconcile(NOW);

    expect(repo.loadMessage.mock.calls).toEqual([]);
    expect(repo.settle.mock.calls).toEqual([]);
    expect(cycle).toEqual({ checked: 5, alive: 5, lost: 0, counts: ZERO });
  });

  it('estado fora da lista (ex.: um valor novo do BullMQ) conta como vivo — não toca', async () => {
    const { service, repo } = setup([candidate('r1')], {
      r1: 'waiting-for-something-new',
    });

    const cycle = await service.reconcile(NOW);

    expect(repo.settle.mock.calls).toEqual([]);
    expect(cycle).toMatchObject({ checked: 1, alive: 1, lost: 0 });
  });
});

describe('TeamStuckReconcilerService.reconcile — erros não param o ciclo', () => {
  it('erro ao consultar o job: não toca e segue o ciclo', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const lookup = Object.assign(new Error('+5592991110001 Pessoa A'), {
      name: 'LookupError',
    });
    const state = Object.assign(new Error('Pessoa B'), { name: 'ReplyError' });
    const all = ['r1', 'r2', 'r3'].map((id) => candidate(id));
    const { service, repo } = setup(all, {
      r1: { getJobError: lookup },
      r2: state,
    });

    const cycle = await service.reconcile(NOW);

    expect(repo.settle.mock.calls).toEqual([[all[2], QUEUE_LOST, NOW]]);
    expect(cycle).toMatchObject({ checked: 3, alive: 0, lost: 1 });
    // Só o recipientId e o NOME do erro: a mensagem do erro pode trazer dado.
    expect(warn.mock.calls).toEqual([
      [{ recipientId: 'r1', error: 'LookupError' }, expect.any(String)],
      [{ recipientId: 'r2', error: 'ReplyError' }, expect.any(String)],
    ]);
  });

  it('erro de banco num candidato: não conta, segue o ciclo e loga só o recipientId', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const all = [candidate('r1', { messageId: 'm1' }), candidate('r2')];
    const { service, repo } = setup(all);
    repo.loadMessage.mockRejectedValueOnce(new Error('+5592991110001'));

    const cycle = await service.reconcile(NOW);

    expect(repo.settle.mock.calls).toEqual([[all[1], QUEUE_LOST, NOW]]);
    expect(cycle).toEqual({
      checked: 2,
      alive: 0,
      lost: 2,
      counts: { ...ZERO, queueLost: 1 },
    });
    expect(error.mock.calls).toEqual([
      [{ recipientId: 'r1' }, expect.any(String)],
    ]);
  });
});

describe('TeamStuckReconcilerService.reconcile — ordem e fila (GH2)', () => {
  it('consulta o job de cada candidato imediatamente antes do settle dele', async () => {
    const all = [candidate('r1', { messageId: 'm1' }), candidate('r2')];
    const { service, calls } = setup(all, { r1: 'completed' });

    await service.reconcile(NOW);

    // Nunca "consulta todos e troca depois": a decisão de cada um vem da
    // consulta feita logo antes da troca dele.
    expect(calls).toEqual([
      'getJob:r1',
      'getState:r1',
      'loadMessage:m1',
      'settle:r1',
      'getJob:r2',
      'settle:r2',
    ]);
  });

  it('nunca chama add nem addBulk', async () => {
    const all = [
      candidate('r1', { messageId: 'm1' }),
      candidate('r2', { messageId: 'm2' }),
      candidate('r3'),
    ];
    const { service, queue } = setup(
      all,
      { r3: 'delayed' },
      {
        m2: {
          status: 'FAILED',
          errorCode: 'evolution.disconnected',
          sentAt: null,
        },
      },
    );

    await service.reconcile(NOW);

    expect(queue.add.mock.calls).toEqual([]);
    expect(queue.addBulk.mock.calls).toEqual([]);
  });
});

describe('TeamStuckReconcilerService.reconcile — contagens (DH8)', () => {
  it('settle perdido não conta', async () => {
    const all = [candidate('r1'), candidate('r2', { dispatchId: 'd2' })];
    const { service, repo, audit } = setup(all);
    repo.settle.mockResolvedValueOnce(false);

    const cycle = await service.reconcile(NOW);

    expect(cycle).toEqual({
      checked: 2,
      alive: 0,
      lost: 2,
      counts: { ...ZERO, queueLost: 1 },
    });
    expect(audit.log.mock.calls.map((call) => call[2])).toEqual(['d2']);
  });

  it('ciclo sem troca não grava trilha', async () => {
    const all = [candidate('r1'), candidate('r2')];
    const { service, repo, audit } = setup(all, { r1: 'waiting' });
    repo.settle.mockResolvedValue(false);

    await service.reconcile(NOW);

    expect(audit.log.mock.calls).toEqual([]);
  });
});

describe('TeamStuckReconcilerService.reconcile — trilha por envio (DH8)', () => {
  it('uma trilha por envio, só com dispatchId e contagens', async () => {
    const sentAt = new Date('2026-11-20T14:00:00.000Z');
    const all = [
      candidate('r1'),
      candidate('r2', { messageId: 'm2' }),
      candidate('r3', { dispatchId: 'd2', messageId: 'm3' }),
      candidate('r4', { dispatchId: 'd2', messageId: 'm4' }),
      candidate('r5', { dispatchId: 'd3' }),
    ];
    const { service, audit } = setup(
      all,
      { r5: 'active' },
      {
        m2: { status: 'SENT', errorCode: null, sentAt },
        m3: { status: 'SENDING', errorCode: null, sentAt: null },
        m4: {
          status: 'FAILED',
          errorCode: 'evolution.disconnected',
          sentAt: null,
        },
      },
    );

    await service.reconcile(NOW);

    expect(audit.log.mock.calls).toEqual([
      [
        'team_whatsapp.stuck_reconciled',
        'TeamWhatsappDispatch',
        'd1',
        { dispatchId: 'd1', ...ZERO, queueLost: 1, sent: 1 },
      ],
      [
        'team_whatsapp.stuck_reconciled',
        'TeamWhatsappDispatch',
        'd2',
        { dispatchId: 'd2', ...ZERO, uncertain: 1, failed: 1 },
      ],
    ]);
  });
});

describe('TeamStuckReconcilerService.reconcile — log do ciclo (GH3)', () => {
  it('log do ciclo sem nome, telefone ou texto', async () => {
    const info = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const all = [candidate('r1'), candidate('r2', { messageId: 'm2' })];
    const { service } = setup(all, { r2: 'waiting' });

    await service.reconcile(NOW);

    expect(info.mock.calls).toEqual([
      [
        {
          checked: 2,
          alive: 1,
          lost: 1,
          counts: { ...ZERO, queueLost: 1 },
        },
        expect.any(String),
      ],
    ]);
  });
});
