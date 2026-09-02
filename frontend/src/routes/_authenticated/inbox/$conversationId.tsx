import { createFileRoute } from '@tanstack/react-router';
import { MessageThread } from '@/features/chat/components/message-thread';

export const Route = createFileRoute('/_authenticated/inbox/$conversationId')({
  component: ConversationView,
});

function ConversationView() {
  const { conversationId } = Route.useParams();
  // Key by conversationId so switching conversations mounts a fresh subtree,
  // discarding the previous thread's composer draft and quoted-reply target.
  // Without this, TanStack Router reuses the instance across param changes and
  // a draft/reply meant for one contact leaks into another.
  return <MessageThread key={conversationId} conversationId={conversationId} />;
}
