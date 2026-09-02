import { instanceColor } from '../instance-color';

export type InboxTabInstance = { id: string; name: string };

export function InboxTabs({
  instances,
  value,
  onChange,
}: {
  instances: InboxTabInstance[];
  value: string | null;
  onChange: (instanceId: string | null) => void;
}) {
  if (instances.length < 2) return null;

  const tabs: Array<{ id: string | null; label: string }> = [
    { id: null, label: 'Todos' },
    ...instances.map((i) => ({ id: i.id, label: i.name })),
  ];

  return (
    <div>
      <div
        className="text-[10px] font-medium uppercase"
        style={{ letterSpacing: '0.06em', color: 'var(--foreground-muted)' }}
      >
        número
      </div>
      <div className="mt-1 flex gap-1.5 overflow-x-auto pb-0.5 text-xs">
        {tabs.map((t) => {
          const selected = value === t.id;
          return (
            <button
              key={t.id ?? '__all__'}
              type="button"
              onClick={() => onChange(t.id)}
              className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5"
              style={{
                background: selected ? 'var(--st-read-bg)' : 'transparent',
                color: selected ? 'var(--brand-purple)' : 'var(--foreground-muted)',
              }}
            >
              {t.id !== null ? (
                <span
                  data-testid={`instance-dot-${t.id}`}
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: instanceColor(t.id) }}
                />
              ) : null}
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
