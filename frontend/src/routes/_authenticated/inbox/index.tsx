import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/inbox/')({
  component: InboxEmpty,
});

function InboxEmpty() {
  return (
    <div className="flex h-full items-center justify-center" style={{ background: 'var(--surface-sunken)' }}>
      <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>Selecione uma conversa para ver as mensagens.</p>
    </div>
  );
}
