import { describe, it, expect, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Job } from 'bullmq';
import type { ClsService } from 'nestjs-cls';
import { BotReplyProcessor } from './bot-reply.processor';
import { BotReplyService } from './bot-reply.service';
import type { BotReplyJob } from '../queue/queue.constants';

function makeJob(data: Partial<BotReplyJob> = {}): Job<BotReplyJob> {
  return { data: { conversationId: 'c1', messageId: 'm1', ...data } } as Job<BotReplyJob>;
}

describe('BotReplyProcessor', () => {
  it('delegates to BotReplyService.handle within a CLS context', async () => {
    const svc = mockDeep<BotReplyService>();
    const cls = mockDeep<ClsService>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cls.run.mockImplementation((cb: any) => cb());
    const processor = new BotReplyProcessor(svc, cls);
    await processor.process(makeJob());
    expect(svc.handle).toHaveBeenCalledWith('c1', 'm1');
  });
});
