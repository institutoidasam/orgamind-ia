import { describe, it, expect, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { ChatEventsService, type ChatEvent } from './chat-events.service';

function makeRedis() {
  const handlers: Record<string, (ch: string, msg: string) => void> = {};
  const sub = {
    subscribe: vi.fn().mockResolvedValue(1),
    on: vi.fn((ev: string, cb: (ch: string, msg: string) => void) => { handlers[ev] = cb; }),
    quit: vi.fn().mockResolvedValue('OK'),
    __emit: (ch: string, msg: string) => handlers['message']?.(ch, msg),
  };
  const pub = { duplicate: vi.fn(() => sub), publish: vi.fn().mockResolvedValue(1) };
  return { pub, sub };
}

const ev: ChatEvent = { type: 'message.created', conversationId: 'c1', instanceId: 'i1' };

describe('ChatEventsService', () => {
  it('publishes serialized events to the chat channel', async () => {
    const { pub } = makeRedis();
    const svc = new ChatEventsService(pub as never);
    await svc.publish(ev);
    expect(pub.publish).toHaveBeenCalledWith('chat:events', JSON.stringify(ev));
  });

  it('re-emits messages received on the subscriber into the stream', async () => {
    const { pub, sub } = makeRedis();
    const svc = new ChatEventsService(pub as never);
    await svc.onModuleInit();
    const next = firstValueFrom(svc.stream$);
    sub.__emit('chat:events', JSON.stringify(ev));
    await expect(next).resolves.toEqual(ev);
  });
});
