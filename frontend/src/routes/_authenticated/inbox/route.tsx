import { createFileRoute, Outlet, useParams } from '@tanstack/react-router';
import { ConversationsList } from '@/features/chat/components/conversations-list';
import { useChatStream } from '@/features/chat/use-chat-stream';

export const Route = createFileRoute('/_authenticated/inbox')({
  component: InboxLayout,
});

function InboxLayout() {
  useChatStream(); // open the live SSE stream while the inbox is mounted
  const params = useParams({ strict: false }) as { conversationId?: string };
  // `grid-rows-[minmax(0,1fr)]` não é enfeite: sem ele o inbox não rola.
  // `grid-auto-rows` é `auto`, então a linha implícita se dimensiona pelo
  // CONTEÚDO — a altura definida aqui (`h-[calc(100vh-8rem)]`) não desce até
  // ela. Com 138 conversas a linha ia a ~2044px, as colunas esticavam junto (o
  // `h-full` delas passa a valer 100% DA LINHA), o `overflow-y-auto` de dentro
  // nunca tinha o que rolar, e o `overflow-hidden` daqui decepava o excedente:
  // o operador via ~10 conversas e não alcançava as outras 128.
  // `minmax(0, 1fr)` trava a linha na altura do contêiner; o `min-h-0` das
  // colunas faz o resto.
  return (
    <div className="grid h-[calc(100vh-8rem)] grid-rows-[minmax(0,1fr)] overflow-hidden rounded-lg" style={{ gridTemplateColumns: '330px 1fr', border: '1px solid var(--border)', background: 'var(--surface)' }}>
      <ConversationsList activeId={params.conversationId} />
      <Outlet />
    </div>
  );
}
