import type { ConversationStatus } from '../schemas';
import { SITUATION_LABEL } from '../situation';

const COLORS: Record<ConversationStatus, { background: string; color: string }> = {
  PENDING: { background: 'var(--brand-orange-soft)', color: 'var(--brand-orange-text)' },
  IN_PROGRESS: { background: 'var(--brand-blue-soft)', color: 'var(--brand-blue)' },
  RESOLVED: { background: 'var(--surface-sunken)', color: 'var(--foreground-muted)' },
};

/** Situação da conversa na linha da lista (K1-10): Pendente, Em atendimento ou Resolvida. */
export function SituationBadge({ situation }: { situation: ConversationStatus }) {
  return (
    <span
      data-testid="situation-badge"
      className="shrink-0 rounded px-1 text-[9px] font-semibold uppercase tracking-wide"
      style={COLORS[situation]}
    >
      {SITUATION_LABEL[situation]}
    </span>
  );
}
