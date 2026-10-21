import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { mockDeep } from 'vitest-mock-extended';
import {
  AUDIT_CLS_KEY,
  type AuditService,
} from '../../shared/audit/audit.service';
import { TeamWhatsappSchedulerProcessor } from './team-whatsapp-scheduler.processor';
import { TeamWhatsappScheduleService } from './team-whatsapp-schedule.service';
import type { TeamWhatsappRepository } from './team-whatsapp.repository';

const NOW = new Date('2026-10-21T12:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TeamWhatsappSchedulerProcessor', () => {
  it('tick chama fireDue com o relógio atual', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const schedule = mockDeep<TeamWhatsappScheduleService>();
    schedule.fireDue.mockResolvedValue({ fired: 0 });
    const cls = {
      run: <T>(fn: () => T) => fn(),
      set: vi.fn<(key: string, ctx: { correlationId: string }) => void>(),
    };

    await new TeamWhatsappSchedulerProcessor(schedule, cls as never).process();

    expect(schedule.fireDue.mock.calls).toEqual([[NOW]]);
    const [[key, ctx]] = cls.set.mock.calls;
    expect(key).toBe(AUDIT_CLS_KEY);
    expect(ctx.correlationId).toMatch(/^team-sched-[0-9a-f-]{36}$/);
  });
});

describe('TeamWhatsappScheduleService.fireDue — isolamento de erro', () => {
  it('erro num envio não impede os outros', async () => {
    const errorLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const repo = mockDeep<TeamWhatsappRepository>();
    const queue = { addBulk: vi.fn().mockResolvedValue([]) };
    const boom = new Error('boom');
    repo.findDueScheduled.mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]);
    repo.claimScheduled
      .mockRejectedValueOnce(boom)
      .mockResolvedValueOnce({ queuedIds: ['r1'], skipped: 0, failed: 0 });
    const service = new TeamWhatsappScheduleService(
      repo,
      mockDeep<AuditService>(),
      queue as never,
    );

    await expect(service.fireDue(NOW)).resolves.toEqual({ fired: 1 });

    expect(repo.findDueScheduled.mock.calls).toEqual([[NOW, 50]]);
    expect(repo.claimScheduled.mock.calls).toEqual([
      ['d1', NOW],
      ['d2', NOW],
    ]);
    expect(queue.addBulk.mock.calls).toEqual([
      [[{ name: 'send', data: { recipientId: 'r1' }, opts: { jobId: 'r1' } }]],
    ]);
    // Log só com o id do envio: nada de nome, texto ou telefone (GC10).
    expect(errorLog.mock.calls).toEqual([
      [{ err: boom, dispatchId: 'd1' }, expect.any(String)],
    ]);
  });
});
