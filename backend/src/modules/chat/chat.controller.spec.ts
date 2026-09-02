import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { firstValueFrom, Subject } from 'rxjs';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatEventsService, type ChatEvent } from './chat-events.service';

describe('ChatController', () => {
  let svc: MockProxy<ChatService>;
  let events: MockProxy<ChatEventsService>;
  let ctrl: ChatController;
  beforeEach(() => {
    svc = mockDeep<ChatService>();
    events = mockDeep<ChatEventsService>();
    (events as any).stream$ = new Subject<ChatEvent>();
    ctrl = new ChatController(svc, events);
  });

  const authedReq = { user: { sub: 'user-1', role: 'OPERATOR' } } as never;

  it('lists conversations, passing the caller id for "me" resolution', async () => {
    svc.listConversations.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 30 } as never);
    expect(await ctrl.list({ filter: 'all', page: 1, pageSize: 30 } as never, authedReq)).toEqual({ items: [], total: 0, page: 1, pageSize: 30 });
    expect(svc.listConversations).toHaveBeenCalledWith(expect.objectContaining({ filter: 'all' }), 'user-1');
  });

  it('assigns a conversation, passing the actor id', async () => {
    svc.assignConversation.mockResolvedValue(undefined as never);
    await ctrl.assign('c1', { userId: 'u9' }, authedReq);
    expect(svc.assignConversation).toHaveBeenCalledWith('c1', 'u9', 'user-1');
  });

  it('unassigns a conversation when userId is null', async () => {
    svc.assignConversation.mockResolvedValue(undefined as never);
    await ctrl.assign('c1', { userId: null }, authedReq);
    expect(svc.assignConversation).toHaveBeenCalledWith('c1', null, 'user-1');
  });

  it('lists messages for a conversation', async () => {
    svc.listMessages.mockResolvedValue({ items: [], nextCursor: null } as never);
    expect(await ctrl.messages('c1', { limit: 30 } as never)).toEqual({ items: [], nextCursor: null });
    expect(svc.listMessages).toHaveBeenCalledWith('c1', { limit: 30 });
  });

  it('streams chat events as SSE MessageEvents', async () => {
    const out = firstValueFrom(ctrl.stream());
    (events as any).stream$.next({ type: 'message.created', conversationId: 'c1', instanceId: 'i1' });
    await expect(out).resolves.toEqual({ data: { type: 'message.created', conversationId: 'c1', instanceId: 'i1' } });
  });
});
