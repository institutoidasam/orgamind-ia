import { useEffect, useMemo, useRef, useState } from 'react';

type Counts = {
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
};

const STATUS_VARS = ['queued', 'sent', 'delivered', 'read', 'failed'] as const;

const LIVE_FLOW_LABEL: Record<'queued' | 'sent' | 'delivered' | 'read' | 'failed', string> = {
  queued: 'na fila',
  sent: 'enviadas',
  delivered: 'entregues',
  read: 'lidas',
  failed: 'falhas',
};

type Particle = {
  id: number;
  status: typeof STATUS_VARS[number];
  duration: number;
  delay: number;
  top: number;
};

export function LiveFlow({ counts }: { counts: Counts }) {
  const [particles, setParticles] = useState<Particle[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    let interval: number | null = null;

    const start = () => {
      if (interval !== null) return;
      interval = window.setInterval(() => {
        const id = nextId.current++;
        const status =
          STATUS_VARS[Math.floor(Math.random() * STATUS_VARS.length)];
        const duration = 2200 + Math.random() * 1400;
        const top = 24 + Math.random() * 180;
        setParticles((p) => [...p, { id, status, duration, delay: 0, top }]);
        window.setTimeout(
          () => setParticles((p) => p.filter((x) => x.id !== id)),
          duration + 100,
        );
      }, 280);
    };

    const stop = () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else start();
    };

    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, []);

  const stages = useMemo(
    () =>
      [
        { left: 12, label: 'na fila', count: counts.queued, color: 'var(--st-queued-fg)' },
        { left: 38, label: 'enviadas', count: counts.sent, color: 'var(--st-sent-fg)' },
        { left: 64, label: 'entregues', count: counts.delivered, color: 'var(--st-delivered-fg)' },
        { left: 88, label: 'lidas', count: counts.read, color: 'var(--st-read-fg)' },
      ] as const,
    [counts],
  );

  return (
    <div
      className="relative overflow-hidden rounded-xl p-5"
      style={{ background: 'var(--surface)', boxShadow: 'var(--ring-soft)' }}
    >
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold">Fluxo ao vivo</h3>
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
          style={{
            background: 'var(--st-read-bg)',
            color: 'var(--st-read-fg)',
            border: '1px solid var(--st-read-border)',
          }}
        >
          <span
            className="inline-block size-1.5 animate-pulse rounded-full"
            style={{ background: 'var(--brand-cyan)' }}
          />
          ao vivo
        </span>
      </div>

      <div className="relative h-[240px] overflow-hidden rounded-lg" style={{ background: 'var(--surface-sunken)' }}>
        {/* Rails / stage labels */}
        {stages.map((s) => (
          <div
            key={s.label}
            className="absolute top-0 flex h-full flex-col items-center justify-center gap-1"
            style={{ left: `${s.left}%`, transform: 'translateX(-50%)' }}
          >
            <div
              className="grid size-12 place-items-center rounded-full ring-1"
              style={{
                background: 'var(--surface)',
                color: s.color,
                boxShadow: 'var(--shadow-xs)',
              }}
            >
              <span className="ds-display-lg !text-2xl">{s.count}</span>
            </div>
            <div className="ds-eyebrow text-[10px]">{s.label}</div>
          </div>
        ))}

        {/* Particles */}
        {particles.map((p) => (
          <span
            key={p.id}
            className="absolute h-3.5 w-6 rounded-sm shadow"
            style={{
              top: p.top,
              left: '12%',
              background: `var(--st-${p.status}-bg)`,
              border: `1px solid var(--st-${p.status}-border)`,
              animation: `flowMove ${p.duration}ms linear forwards`,
            }}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-3 text-xs" style={{ color: 'var(--foreground-muted)' }}>
        {(['queued', 'sent', 'delivered', 'read', 'failed'] as const).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block size-2 rounded-sm"
              style={{ background: `var(--st-${s}-bg)`, border: `1px solid var(--st-${s}-border)` }}
            />
            {LIVE_FLOW_LABEL[s]}
          </span>
        ))}
      </div>

      <style>{`
        @keyframes flowMove {
          0%   { left: 12%; opacity: 0; }
          10%  { opacity: 1; }
          90%  { opacity: 1; }
          100% { left: 88%; opacity: 0; }
        }
      `}</style>
    </div>
  );
}
