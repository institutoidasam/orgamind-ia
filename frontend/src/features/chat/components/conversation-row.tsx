import type { ConversationSummary } from '../schemas';
import { initials } from '@/lib/initials';
import { instanceColor } from '../instance-color';
import { ProviderBadge } from '@/features/whatsapp/provider-scope';

function timeShort(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('pt-BR');
}

export function ConversationRow({
  c,
  active,
  onClick,
  showInstanceBadge = false,
  showProviderBadge = false,
}: {
  c: ConversationSummary;
  active: boolean;
  onClick: () => void;
  showInstanceBadge?: boolean;
  /** Multi-provider channels (F4) — only meaningful when c.provider is set. */
  showProviderBadge?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left"
      style={{ background: active ? 'var(--surface-hover)' : 'transparent', borderLeft: active ? '3px solid var(--brand-purple)' : '3px solid transparent' }}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-full text-xs font-semibold" style={{ background: 'var(--surface-sunken)', color: 'var(--foreground-muted)' }}>
        {c.profilePicUrl ? <img src={c.profilePicUrl} alt="" className="size-10 rounded-full object-cover" /> : initials(c.displayName)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">{c.displayName}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            {showProviderBadge && c.provider ? (
              <ProviderBadge provider={c.provider} className="h-4 px-1.5 py-0 text-[9px]" />
            ) : null}
            {showInstanceBadge ? (
              <span
                className="flex items-center gap-1 rounded px-1 text-[9px] font-semibold uppercase tracking-wide"
                style={{ background: 'var(--surface-sunken)', color: 'var(--foreground-muted)' }}
              >
                <span
                  data-testid="conversation-instance-dot"
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: instanceColor(c.instanceId) }}
                />
                {c.instanceName}
              </span>
            ) : null}
            <span className="text-[11px]" style={{ color: 'var(--foreground-muted)' }}>{timeShort(c.lastMessageAt)}</span>
          </span>
        </span>
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-xs" style={{ color: 'var(--foreground-muted)' }}>{c.lastMessagePreview ?? ''}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            {c.assignedUserId ? (
              <span
                data-testid="assignee-badge"
                title={c.assignedUserName ?? undefined}
                className="grid size-4 place-items-center rounded-full text-[8px] font-bold text-white"
                style={{ background: 'var(--brand-purple)' }}
              >
                {initials(c.assignedUserName)}
              </span>
            ) : null}
            {c.unreadCount > 0 ? (
              <span className="rounded-full px-1.5 text-[10px] font-bold text-white" style={{ background: 'var(--brand-purple)' }}>{c.unreadCount}</span>
            ) : null}
          </span>
        </span>
      </span>
    </button>
  );
}
