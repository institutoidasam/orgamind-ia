/** Assignee filter value: null = Todas, 'me' = Minhas, 'unassigned' = Não atribuídas. */
export type AssigneeFilter = null | 'me' | 'unassigned';

export function AssigneeTabs({
  value,
  onChange,
}: {
  value: AssigneeFilter;
  onChange: (value: AssigneeFilter) => void;
}) {
  const tabs: Array<{ id: AssigneeFilter; label: string }> = [
    { id: null, label: 'Todas' },
    { id: 'me', label: 'Minhas' },
    { id: 'unassigned', label: 'Não atribuídas' },
  ];

  return (
    <div>
      <div
        className="text-[10px] font-medium uppercase"
        style={{ letterSpacing: '0.06em', color: 'var(--foreground-muted)' }}
      >
        atribuição
      </div>
      <div className="mt-1 flex gap-1.5 overflow-x-auto pb-0.5 text-xs">
        {tabs.map((t) => {
          const selected = value === t.id;
          return (
            <button
              key={t.id ?? '__all__'}
              type="button"
              onClick={() => onChange(t.id)}
              className="shrink-0 rounded-full px-2.5 py-0.5"
              style={{
                background: selected ? 'var(--brand-orange-soft)' : 'transparent',
                color: selected ? 'var(--brand-orange-text)' : 'var(--foreground-muted)',
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
