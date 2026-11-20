import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { AUDIT_CLS_KEY } from '../../shared/audit/audit.service';
import { TeamWhatsappStuckProcessor } from './team-whatsapp-stuck.processor';
import type { TeamStuckReconcilerService } from './team-stuck-reconciler.service';

const NOW = new Date('2026-11-20T15:05:00.000Z');

afterEach(() => {
  vi.useRealTimers();
});

describe('TeamWhatsappStuckProcessor', () => {
  it('process chama reconcile uma vez com a hora atual (new Date())', async () => {
    // Só o relógio do processo: nenhuma linha gravada pelo banco aqui.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const reconciler = mockDeep<TeamStuckReconcilerService>();
    reconciler.reconcile.mockResolvedValue({
      checked: 0,
      alive: 0,
      lost: 0,
      counts: { queueLost: 0, missing: 0, sent: 0, failed: 0, uncertain: 0 },
    });
    const cls = {
      run: <T>(fn: () => T) => fn(),
      set: vi.fn<(key: string, ctx: { correlationId: string }) => void>(),
    };

    await new TeamWhatsappStuckProcessor(reconciler, cls as never).process();

    expect(reconciler.reconcile.mock.calls).toEqual([[NOW]]);
    // A trilha do ciclo sai amarrada a um correlationId próprio do tick.
    const [[key, ctx]] = cls.set.mock.calls;
    expect(key).toBe(AUDIT_CLS_KEY);
    expect(ctx.correlationId).toMatch(/^team-stuck-[0-9a-f-]{36}$/);
  });
});
