import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatSyncController } from './chat-sync.controller';

describe('ChatSyncController', () => {
  let queue: { add: ReturnType<typeof vi.fn> };
  let ctrl: ChatSyncController;
  beforeEach(() => {
    queue = { add: vi.fn().mockResolvedValue({ id: 'job1' }) };
    ctrl = new ChatSyncController(queue as never);
  });
  it('enqueues a history sync job for the instance', async () => {
    const r = await ctrl.sync({ instanceId: 'i1' } as never);
    expect(queue.add).toHaveBeenCalledWith('sync', { instanceId: 'i1' });
    expect(r).toEqual({ enqueued: true });
  });
});
