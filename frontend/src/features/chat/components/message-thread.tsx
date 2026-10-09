import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, PauseCircle } from 'lucide-react';
import { useConversation, useConversationMessages, useMarkRead, useResumeBot } from '../api';
import { MessageBubble } from './message-bubble';
import { MessageComposer, type ReplyTarget } from './message-composer';
import { AssignMenu } from './assign-menu';
import { BotControl } from './bot-control';
import { Button } from '@/components/ui/button';
import { QueryErrorFallback } from '@/components/query-error-fallback';
import { initials } from '@/lib/initials';
import type { ChatMessage, ConversationSummary } from '../schemas';

function PausedBotBanner({ conversationId }: { conversationId: string }) {
  const resume = useResumeBot();
  return (
    <div
      data-testid="paused-bot-banner"
      className="flex items-center gap-2.5 px-4 py-2.5 text-sm"
      style={{ background: 'var(--warning-surface, #fef3c7)', color: 'var(--warning-foreground, #92400e)', borderBottom: '1px solid var(--border)' }}
    >
      <PauseCircle className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">Respostas automáticas pausadas nesta conversa.</span>
      <Button size="sm" variant="outline" onClick={() => resume.mutateAsync(conversationId)} disabled={resume.isPending}>
        Reativar bot
      </Button>
    </div>
  );
}

function ThreadAvatar({ conv }: { conv?: ConversationSummary }) {
  return (
    <span
      data-testid="thread-avatar"
      className="grid size-9 shrink-0 place-items-center rounded-full text-xs font-semibold"
      style={{ background: 'var(--surface-sunken)', color: 'var(--foreground-muted)' }}
    >
      {conv?.profilePicUrl
        ? <img src={conv.profilePicUrl} alt="" className="size-9 rounded-full object-cover" />
        : initials(conv?.displayName ?? '')}
    </span>
  );
}

function ThreadIdentity({ conv }: { conv?: ConversationSummary }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-semibold">{conv?.displayName ?? '…'}</div>
      <div className="text-[11px]" style={{ color: 'var(--foreground-muted)' }}>
        {conv?.phoneE164 ?? 'Número desconhecido'} · {conv?.instanceName}
        {conv?.assignedUserName ? <span data-testid="thread-assignee"> · {conv.assignedUserName}</span> : null}
      </div>
    </div>
  );
}

function ThreadHeader({ conversationId, conv }: { conversationId: string; conv?: ConversationSummary }) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5" style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
      <a
        href="/inbox"
        aria-label="Voltar para conversas"
        className="grid size-8 shrink-0 place-items-center rounded-md lg:hidden"
        style={{ color: 'var(--brand-primary)', background: 'var(--surface-sunken)' }}
      >
        <ArrowLeft className="size-4" />
      </a>
      <ThreadAvatar conv={conv} />
      <ThreadIdentity conv={conv} />
      {conv ? (
        <>
          <BotControl
            conversationId={conversationId}
            botName={conv.botName ?? null}
            botPaused={conv.botPaused ?? false}
          />
          <AssignMenu
            conversationId={conversationId}
            assignedUserId={conv.assignedUserId ?? null}
            assignedUserName={conv.assignedUserName ?? null}
          />
        </>
      ) : null}
    </div>
  );
}

function ThreadBody({
  scrollRef, messages, isLoading, hasNextPage, fetchNextPage, onReply,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  messages: ChatMessage[];
  isLoading: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  onReply: (m: ChatMessage) => void;
}) {
  // `min-h-0` pelo mesmo motivo da lista de conversas: sem ele este painel
  // cresce até o tamanho do conteúdo em vez de rolar — e o composer é empurrado
  // para fora da tela, deixando o operador sem como responder.
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-4 py-4">
      {hasNextPage ? (
        <button type="button" onClick={() => fetchNextPage()} className="mx-auto block text-xs underline" style={{ color: 'var(--foreground-muted)' }}>
          Carregar mensagens anteriores
        </button>
      ) : null}
      {isLoading ? (
        <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>Carregando…</p>
      ) : (
        messages.map((m) => <MessageBubble key={m.id} message={m} onReply={m.providerMessageId ? onReply : undefined} />)
      )}
    </div>
  );
}

export function MessageThread({ conversationId }: { conversationId: string }) {
  const conv = useConversation(conversationId);
  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage } = useConversationMessages(conversationId);
  const markRead = useMarkRead();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [reply, setReply] = useState<ReplyTarget>(null);
  const messages = data ? [...data.pages].reverse().flatMap((p) => p.items) : [];
  const newestId = messages.length ? messages[messages.length - 1].id : null;

  // Mark the conversation read when opened / when new unread arrives.
  useEffect(() => {
    if (conv.data && conv.data.unreadCount > 0) markRead.mutate(conversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, conv.data?.unreadCount]);

  // Scroll anchoring. Only force-scroll to the bottom when a NEW message lands
  // at the end (the newest id changed) or when the operator was already near
  // the bottom. Prepending older history (newest id unchanged, length grows)
  // must NOT yank the viewport down — preserve the reading position instead.
  const lastNewestId = useRef<string | null>(null);
  const prevScrollHeight = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    const isNewMessage = newestId !== lastNewestId.current;
    const firstRender = lastNewestId.current === null;
    const nearBottom = el ? el.scrollHeight - el.scrollTop - el.clientHeight < 120 : true;

    if (isNewMessage && (firstRender || nearBottom)) {
      // `scrollIntoView` também rola o documento e esconde o cabeçalho sob a
      // topbar fixa. Atualizar só o contêiner mantém a conversa visível.
      if (el) el.scrollTop = el.scrollHeight;
    } else if (el && el.scrollHeight !== prevScrollHeight.current) {
      // History prepended (or anything that grew the content above the fold):
      // keep the currently-visible message in place by offsetting scrollTop by
      // the height delta added above.
      const delta = el.scrollHeight - prevScrollHeight.current;
      if (delta > 0 && !isNewMessage) el.scrollTop += delta;
    }

    if (el) prevScrollHeight.current = el.scrollHeight;
    lastNewestId.current = newestId;
    // newestId + messages.length capture both "new at end" and "history prepended".
  }, [newestId, messages.length]);

  if (isError) return <div className="p-4"><QueryErrorFallback error={error} onRetry={() => refetch()} /></div>;

  function startReply(m: ChatMessage) {
    setReply({ waMessageId: m.providerMessageId ?? '', preview: (m.content ?? '').slice(0, 80) || 'mensagem' });
  }

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--canvas)' }}>
      <ThreadHeader conversationId={conversationId} conv={conv.data} />
      {conv.data?.botName && conv.data.botPaused ? (
        <PausedBotBanner conversationId={conversationId} />
      ) : null}
      <ThreadBody
        scrollRef={scrollRef}
        messages={messages}
        isLoading={isLoading}
        hasNextPage={hasNextPage}
        fetchNextPage={fetchNextPage}
        onReply={startReply}
      />
      <MessageComposer
        conversationId={conversationId}
        reply={reply}
        onClearReply={() => setReply(null)}
        provider={conv.data?.provider}
        twilioWindowExpiresAt={conv.data?.twilioWindowExpiresAt}
      />
    </div>
  );
}
