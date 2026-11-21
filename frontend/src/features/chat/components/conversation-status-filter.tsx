import type { ConversationStatusFilterValue } from './conversation-status';

const OPTIONS: Array<{ id: ConversationStatusFilterValue; label: string }> = [
  { id: 'open', label: 'Abertas' },
  { id: 'resolved', label: 'Resolvidas' },
];

export function ConversationStatusFilter({
  value,
  onChange,
}: {
  value: ConversationStatusFilterValue;
  onChange: (value: ConversationStatusFilterValue) => void;
}) {
  return (
    <div>
      <div
        className="text-[10px] font-medium uppercase"
        style={{ letterSpacing: '0.06em', color: 'var(--foreground-muted)' }}
      >
        situação
      </div>
      <div role="group" aria-label="Situação" className="mt-1 flex gap-1.5 text-xs">
        {OPTIONS.map((o) => {
          const selected = value === o.id;
          return (
            <button
              key={o.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(o.id)}
              className="shrink-0 rounded-full px-2.5 py-0.5"
              style={{
                background: selected ? 'var(--brand-orange-soft)' : 'transparent',
                color: selected ? 'var(--brand-orange-text)' : 'var(--foreground-muted)',
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
