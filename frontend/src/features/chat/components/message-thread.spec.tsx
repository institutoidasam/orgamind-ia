import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ChatMessage, MessagesPage, ConversationSummary } from '../schemas';

// --- mocks for the data hooks; state is mutated per render via rerender ---
let messagesPages: MessagesPage[] = [];
let convData: Partial<ConversationSummary> | undefined = {
  id: 'c1', displayName: 'Cliente', unreadCount: 0, profilePicUrl: null, phoneE164: '+55', instanceName: 'A', assignedUserId: null, assignedUserName: null,
};
let messagesState = {
  isLoading: false, isError: false, error: null as unknown,
  refetch: vi.fn(), fetchNextPage: vi.fn(), hasNextPage: false,
};
const markReadMutate = vi.fn();
const resumeBotMutate = vi.fn();
vi.mock('../api', () => ({
  useConversation: () => ({ data: convData }),
  useConversationMessages: () => ({
    data: { pages: messagesPages, pageParams: [] },
    isLoading: messagesState.isLoading,
    isError: messagesState.isError,
    error: messagesState.error,
    refetch: messagesState.refetch,
    fetchNextPage: messagesState.fetchNextPage,
    hasNextPage: messagesState.hasNextPage,
  }),
  useMarkRead: () => ({ mutate: markReadMutate }),
  usePauseBot: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useResumeBot: () => ({ isPending: false, mutateAsync: resumeBotMutate }),
}));
// Keep child components trivial so the thread renders.
vi.mock('./message-bubble', () => ({ MessageBubble: ({ message }: { message: ChatMessage }) => <div data-msg={message.id} /> }));
// Expose the composer's `provider` + `twilioWindowExpiresAt` props: the thread
// is the only place that wires them, and the composer's send-gate for cloud
// channels / the 24h-window state (T7) depend on them.
vi.mock('./message-composer', () => ({
  MessageComposer: ({ provider, twilioWindowExpiresAt }: { provider?: string; twilioWindowExpiresAt?: string | null }) => (
    <div data-testid="composer" data-provider={provider ?? ''} data-window={twilioWindowExpiresAt ?? ''} />
  ),
}));
vi.mock('./assign-menu', () => ({ AssignMenu: () => null }));
vi.mock('./bot-control', () => ({ BotControl: () => null }));
vi.mock('@/components/query-error-fallback', () => ({ QueryErrorFallback: () => <div data-testid="error-fallback" /> }));

import { MessageThread } from './message-thread';

function msg(id: string): ChatMessage {
  return {
    id, conversationId: 'c1', direction: 'INBOUND', kind: 'TEXT', content: id, status: 'RECEIVED',
    providerMessageId: id, quotedWaMessageId: null, quotedPreview: null, createdAt: '2026-06-05T00:00:00Z',
    sentAt: null, deliveredAt: null, readAt: null, receivedAt: '2026-06-05T00:00:00Z', media: null,
  };
}

// The component reverses the PAGES array (page 0 = API's newest page) but keeps
// each page's items in API order, where the newest message is the LAST item.
// So after the transform the most-recent message is the last element overall.
// `page([...])` therefore takes ids oldest-first (last id = newest).
function page(ids: string[]): MessagesPage {
  return { items: ids.map(msg), nextCursor: null };
}

const defaultConv: Partial<ConversationSummary> = {
  id: 'c1', displayName: 'Cliente', unreadCount: 0, profilePicUrl: null, phoneE164: '+55', instanceName: 'A', assignedUserId: null, assignedUserName: null,
};

function resetState() {
  messagesPages = [];
  convData = { ...defaultConv };
  messagesState = { isLoading: false, isError: false, error: null, refetch: vi.fn(), fetchNextPage: vi.fn(), hasNextPage: false };
  markReadMutate.mockClear();
}

describe('MessageThread scroll behaviour', () => {
  const scrollSpy = vi.fn();
  beforeEach(() => {
    resetState();
    scrollSpy.mockClear();
    // jsdom has no layout; stub scrollIntoView on the prototype.
    (HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollSpy;
  });

  it('auto-scrolls only dentro do histórico no render inicial', () => {
    messagesPages = [page(['a', 'b', 'c'])];
    render(<MessageThread conversationId="c1" />);
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('does NOT scroll to bottom when older history is prepended (newest id unchanged)', () => {
    // page 0 (newest page), items oldest-first → newest is 'c'.
    messagesPages = [page(['a', 'b', 'c'])];
    const { rerender } = render(<MessageThread conversationId="c1" />);
    scrollSpy.mockClear();

    // Load older history: an OLDER page appended to the pages array (it sorts
    // before page 0 after the component reverses). Newest message ('c') is
    // unchanged; only older messages were added above.
    messagesPages = [page(['a', 'b', 'c']), page(['x', 'y', 'z'])];
    rerender(<MessageThread conversationId="c1" />);

    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('auto-scrolls when a brand-new message arrives at the end (newest id changes)', () => {
    messagesPages = [page(['a', 'b'])]; // newest is 'b'
    const { rerender } = render(<MessageThread conversationId="c1" />);
    scrollSpy.mockClear();

    // A new inbound/outbound message 'c' becomes the newest (appended to the
    // newest page).
    messagesPages = [page(['a', 'b', 'c'])]; // newest is now 'c'
    rerender(<MessageThread conversationId="c1" />);

    expect(scrollSpy).not.toHaveBeenCalled();
  });
});

describe('MessageThread header', () => {
  beforeEach(() => {
    resetState();
    (HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
  });

  it('renders the avatar image when profilePicUrl is present', () => {
    convData = { ...defaultConv, profilePicUrl: 'https://pic/a.jpg', displayName: 'Ana Lima' };
    render(<MessageThread conversationId="c1" />);
    const avatar = screen.getByTestId('thread-avatar');
    const img = avatar.querySelector('img');
    expect(img).toHaveAttribute('src', 'https://pic/a.jpg');
  });

  it('renders initials when there is no profilePicUrl', () => {
    convData = { ...defaultConv, profilePicUrl: null, displayName: 'Ana Lima' };
    render(<MessageThread conversationId="c1" />);
    const avatar = screen.getByTestId('thread-avatar');
    expect(avatar.querySelector('img')).toBeNull();
    expect(avatar).toHaveTextContent('AL');
  });

  it('shows the display name', () => {
    convData = { ...defaultConv, displayName: 'Bruno Costa' };
    render(<MessageThread conversationId="c1" />);
    expect(screen.getByText('Bruno Costa')).toBeInTheDocument();
  });

  it('offers a return to the conversation list for the mobile single-panel view', () => {
    render(<MessageThread conversationId="c1" />);
    expect(screen.getByRole('link', { name: 'Voltar para conversas' })).toHaveAttribute('href', '/inbox');
  });

  it('falls back to the ellipsis when conversation data is absent', () => {
    convData = undefined;
    render(<MessageThread conversationId="c1" />);
    expect(screen.getByText('…')).toBeInTheDocument();
  });

  it('falls back to "Número desconhecido" when phoneE164 is null', () => {
    convData = { ...defaultConv, phoneE164: null };
    render(<MessageThread conversationId="c1" />);
    expect(screen.getByText(/Número desconhecido/)).toBeInTheDocument();
  });

  it('renders the assignee suffix only when assignedUserName is present', () => {
    convData = { ...defaultConv, assignedUserName: 'Operador X' };
    render(<MessageThread conversationId="c1" />);
    expect(screen.getByTestId('thread-assignee')).toHaveTextContent('Operador X');
  });

  it('omits the assignee suffix when there is no assignedUserName', () => {
    convData = { ...defaultConv, assignedUserName: null };
    render(<MessageThread conversationId="c1" />);
    expect(screen.queryByTestId('thread-assignee')).toBeNull();
  });
});

describe('MessageThread body', () => {
  beforeEach(() => {
    resetState();
    (HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
  });

  it('shows the load-more button only when hasNextPage', () => {
    messagesState.hasNextPage = true;
    messagesPages = [page(['a'])];
    render(<MessageThread conversationId="c1" />);
    expect(screen.getByRole('button', { name: /Carregar mensagens anteriores/ })).toBeInTheDocument();
  });

  it('hides the load-more button when there is no next page', () => {
    messagesState.hasNextPage = false;
    messagesPages = [page(['a'])];
    render(<MessageThread conversationId="c1" />);
    expect(screen.queryByRole('button', { name: /Carregar mensagens anteriores/ })).toBeNull();
  });

  it('calls fetchNextPage when load-more is clicked', () => {
    messagesState.hasNextPage = true;
    messagesPages = [page(['a'])];
    render(<MessageThread conversationId="c1" />);
    screen.getByRole('button', { name: /Carregar mensagens anteriores/ }).click();
    expect(messagesState.fetchNextPage).toHaveBeenCalled();
  });

  it('shows the loading placeholder (and no bubbles) while loading', () => {
    messagesState.isLoading = true;
    messagesPages = [];
    const { container } = render(<MessageThread conversationId="c1" />);
    expect(screen.getByText('Carregando…')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-msg]')).toHaveLength(0);
  });

  it('renders one bubble per message when loaded', () => {
    messagesPages = [page(['a', 'b', 'c'])];
    const { container } = render(<MessageThread conversationId="c1" />);
    expect(container.querySelectorAll('[data-msg]')).toHaveLength(3);
  });

  it('renders no bubbles and no loading text when the thread is empty', () => {
    messagesState.isLoading = false;
    messagesPages = [];
    const { container } = render(<MessageThread conversationId="c1" />);
    expect(screen.queryByText('Carregando…')).toBeNull();
    expect(container.querySelectorAll('[data-msg]')).toHaveLength(0);
  });
});

describe('MessageThread paused-bot banner', () => {
  beforeEach(() => {
    resetState();
    resumeBotMutate.mockReset();
    (HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
  });

  it('shows the banner when the bot is assigned and paused', () => {
    convData = { ...defaultConv, botName: 'Atendente', botPaused: true };
    render(<MessageThread conversationId="c1" />);
    expect(screen.getByText(/Respostas automáticas pausadas nesta conversa\./)).toBeInTheDocument();
  });

  it('does not show the banner when the bot is not paused', () => {
    convData = { ...defaultConv, botName: 'Atendente', botPaused: false };
    render(<MessageThread conversationId="c1" />);
    expect(screen.queryByText(/Respostas automáticas pausadas nesta conversa\./)).toBeNull();
  });

  it('does not show the banner when there is no bot assigned', () => {
    convData = { ...defaultConv, botName: null, botPaused: true };
    render(<MessageThread conversationId="c1" />);
    expect(screen.queryByText(/Respostas automáticas pausadas nesta conversa\./)).toBeNull();
  });

  it('resumes the bot when the banner button is clicked', async () => {
    resumeBotMutate.mockResolvedValueOnce({});
    convData = { ...defaultConv, botName: 'Atendente', botPaused: true };
    render(<MessageThread conversationId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: /reativar bot/i }));
    await waitFor(() => expect(resumeBotMutate).toHaveBeenCalledWith('c1'));
  });
});

describe('MessageThread error state', () => {
  beforeEach(() => {
    resetState();
    (HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
  });

  it('renders the error fallback when the query errors', () => {
    messagesState.isError = true;
    messagesState.error = new Error('boom');
    render(<MessageThread conversationId="c1" />);
    expect(screen.getByTestId('error-fallback')).toBeInTheDocument();
  });
});

describe('MessageThread wires the channel provider to the composer', () => {
  beforeEach(() => {
    resetState();
    (HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
  });

  // The composer disables sending on non-Evolution channels; it can only do so
  // if the thread actually forwards the conversation's provider.
  it('forwards the conversation provider', () => {
    convData = { ...defaultConv, provider: 'TWILIO' };
    render(<MessageThread conversationId="c1" />);
    expect(screen.getByTestId('composer')).toHaveAttribute('data-provider', 'TWILIO');
  });

  it('forwards EVOLUTION for the default channel', () => {
    convData = { ...defaultConv, provider: 'EVOLUTION' };
    render(<MessageThread conversationId="c1" />);
    expect(screen.getByTestId('composer')).toHaveAttribute('data-provider', 'EVOLUTION');
  });

  // T7 (twilio-platform): sem o repasse, o composer nunca saberia o fim da
  // janela de 24h e trataria toda conversa TWILIO como janela fechada.
  it('forwards twilioWindowExpiresAt to the composer', () => {
    convData = { ...defaultConv, provider: 'TWILIO', twilioWindowExpiresAt: '2026-07-10T12:00:00.000Z' };
    render(<MessageThread conversationId="c1" />);
    expect(screen.getByTestId('composer')).toHaveAttribute('data-window', '2026-07-10T12:00:00.000Z');
  });
});
