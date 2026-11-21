import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ConversationSummary } from '../schemas';

let convData: Partial<ConversationSummary> | undefined;
vi.mock('../api', () => ({
  useConversation: () => ({ data: convData }),
  useConversationMessages: () => ({
    data: { pages: [], pageParams: [] }, isLoading: false, isError: false, error: null,
    refetch: vi.fn(), fetchNextPage: vi.fn(), hasNextPage: false,
  }),
  useMarkRead: () => ({ mutate: vi.fn() }),
  useResumeBot: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock('./message-composer', () => ({ MessageComposer: () => null }));
vi.mock('./bot-control', () => ({ BotControl: () => null }));
vi.mock('./last-dispatch-banner', () => ({ LastDispatchBanner: () => null }));
vi.mock('./conversation-history', () => ({ ConversationHistory: () => null }));
vi.mock('./conversation-actions', () => ({
  ConversationActions: ({ conv }: { conv: ConversationSummary }) => <div data-testid="actions" data-conv={conv.id} />,
}));

import { MessageThread } from './message-thread';

const base: Partial<ConversationSummary> = {
  id: 'c1', displayName: 'Cliente', unreadCount: 0, profilePicUrl: null, phoneE164: '+5592991110001', instanceName: 'A',
};

describe('MessageThread — cabeçalho com situação e ações (K1)', () => {
  it('aceite 10: mostra a situação e o atendente inativo com "(inativo)"', () => {
    convData = { ...base, status: 'IN_PROGRESS', assignedUserId: 'u1', assignedUserName: 'Atendente A', assignedUserActive: false };
    render(<MessageThread conversationId="c1" />);
    expect(screen.getByTestId('situation-badge')).toHaveTextContent('Em atendimento');
    expect(screen.getByTestId('thread-assignee')).toHaveTextContent('Atendente A (inativo)');
  });

  it('monta ConversationActions com a conversa mostrada e, sem conversa, não monta', () => {
    convData = { ...base, status: 'PENDING', assignedUserId: null, assignedUserName: null };
    const view = render(<MessageThread conversationId="c1" />);
    expect(screen.getByTestId('situation-badge')).toHaveTextContent('Pendente');
    expect(screen.getByTestId('actions')).toHaveAttribute('data-conv', 'c1');
    view.unmount();

    convData = undefined;
    render(<MessageThread conversationId="c1" />);
    expect(screen.queryByTestId('actions')).toBeNull();
    expect(screen.queryByTestId('situation-badge')).toBeNull();
  });
});
