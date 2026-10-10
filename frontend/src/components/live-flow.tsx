type Counts = { queued: number; sent: number; delivered: number; read: number; failed: number };
type Status = keyof Counts;

const FLOW_COUNTERS: Array<{ status: Status; label: string }> = [
  { status: 'queued', label: 'Na fila' },
  { status: 'sent', label: 'Enviadas' },
  { status: 'delivered', label: 'Entregues' },
  { status: 'read', label: 'Lidas' },
  { status: 'failed', label: 'Falhas' },
];

function FlowHeader() {
  return (
    <header className="border-b pb-3" style={{ borderColor: 'var(--border)' }}>
      <h3 className="text-sm font-semibold" style={{ color: 'var(--brand-primary)' }}>
        Fluxo ao vivo
      </h3>
      <p className="mt-0.5 text-xs" style={{ color: 'var(--foreground-muted)' }}>
        Mensagens registradas por etapa
      </p>
    </header>
  );
}

function FlowCounter({ status, label, count }: { status: Status; label: string; count: number }) {
  return (
    <div
      aria-label={`${label}: ${count}`}
      className="rounded-lg border p-3"
      data-testid={`flow-counter-${status}`}
      style={{
        background: `var(--st-${status}-bg)`,
        borderColor: `var(--st-${status}-border)`,
        color: `var(--st-${status}-fg)`,
      }}
    >
      <div className="text-[10px] font-medium uppercase tracking-[0.08em]">{label}</div>
      <div className="mt-1 font-sans text-2xl font-bold leading-none tabular-nums">{count}</div>
    </div>
  );
}

export function LiveFlow({ counts }: { counts: Counts }) {
  return (
    <section
      aria-labelledby="live-flow-title"
      className="overflow-hidden rounded-[10px] border p-4"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      <div id="live-flow-title">
        <FlowHeader />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3" role="list">
        {FLOW_COUNTERS.map(({ status, label }) => (
          <div key={status} role="listitem">
            <FlowCounter status={status} label={label} count={counts[status]} />
          </div>
        ))}
      </div>
    </section>
  );
}
