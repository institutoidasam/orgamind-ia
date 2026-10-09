import { useEffect, useRef, useState } from 'react';

type Counts = { queued: number; sent: number; delivered: number; read: number; failed: number };
type Status = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
type Particle = { id: number; status: Status; duration: number; top: number };

const STATUS_VARS: Status[] = ['queued', 'sent', 'delivered', 'read', 'failed'];
const FLOW_HEIGHT_PX = 160;
const PARTICLE_HEIGHT_PX = 14;
const PARTICLE_VERTICAL_INSET_PX = 16;
const PARTICLE_TOP_RANGE_PX = FLOW_HEIGHT_PX - PARTICLE_HEIGHT_PX - PARTICLE_VERTICAL_INSET_PX * 2;
const RANDOM_UINT_RANGE = 2 ** 32;
const LIVE_FLOW_LABEL: Record<Status, string> = {
  queued: 'na fila', sent: 'enviadas', delivered: 'entregues', read: 'lidas', failed: 'falhas',
};

function randomUnit() {
  const value = new Uint32Array(1);
  globalThis.crypto.getRandomValues(value);
  return value[0] / RANDOM_UINT_RANGE;
}

function nextParticle(id: number): Particle {
  return {
    id,
    status: STATUS_VARS[Math.floor(randomUnit() * STATUS_VARS.length)],
    duration: 2200 + randomUnit() * 1400,
    top: PARTICLE_VERTICAL_INSET_PX + randomUnit() * PARTICLE_TOP_RANGE_PX,
  };
}

function useFlowParticles() {
  const [particles, setParticles] = useState<Particle[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    let interval: ReturnType<typeof globalThis.setInterval> | null = null;
    const stop = () => {
      if (interval !== null) globalThis.clearInterval(interval);
      interval = null;
    };
    const start = () => {
      if (interval !== null) return;
      interval = globalThis.setInterval(() => {
        const particle = nextParticle(nextId.current++);
        setParticles((current) => [...current, particle]);
        globalThis.setTimeout(
          () => setParticles((current) => current.filter((item) => item.id !== particle.id)),
          particle.duration + 100,
        );
      }, 280);
    };
    const onVisibility = () => globalThis.document.visibilityState === 'hidden' ? stop() : start();

    onVisibility();
    globalThis.document.addEventListener('visibilitychange', onVisibility);
    return () => {
      globalThis.document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, []);

  return particles;
}

function FlowHeader() {
  return (
    <div className="mb-3 flex items-center justify-between">
      <div>
        <h3 className="text-sm font-semibold" style={{ color: 'var(--brand-primary)' }}>Fluxo ao vivo</h3>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--foreground-muted)' }}>Acompanhamento das mensagens em tempo real</p>
      </div>
      <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium" style={{ background: 'var(--st-read-bg)', color: 'var(--st-read-fg)', border: '1px solid var(--st-read-border)' }}>
        <span className="inline-block size-1.5 animate-pulse rounded-full" style={{ background: 'var(--brand-orange)' }} />
        ao vivo
      </span>
    </div>
  );
}

function FlowCanvas({ counts, particles }: { counts: Counts; particles: Particle[] }) {
  const stages = [
    { status: 'queued', left: 12, count: counts.queued }, { status: 'sent', left: 38, count: counts.sent },
    { status: 'delivered', left: 64, count: counts.delivered }, { status: 'read', left: 88, count: counts.read },
  ] as const;
  return (
    <div className="relative h-40 overflow-hidden rounded-lg border" style={{ background: 'var(--canvas)', borderColor: 'var(--border)' }}>
      {stages.map(({ status, left, count }) => <FlowStage key={status} status={status} left={left} count={count} />)}
      {particles.map((particle) => <FlowParticle key={particle.id} particle={particle} />)}
    </div>
  );
}

function FlowStage({ status, left, count }: { status: Status; left: number; count: number }) {
  return (
    <div data-testid={`flow-stage-${status}`} className="absolute top-0 z-10 flex h-full flex-col items-center justify-center gap-1" style={{ left: `${left}%`, transform: 'translateX(-50%)' }}>
      <div className="grid size-10 place-items-center rounded-full border" style={{ background: 'var(--surface)', color: `var(--st-${status}-fg)`, borderColor: 'var(--border)' }}>
        <span className="font-sans text-xl font-bold leading-none tabular-nums">{count}</span>
      </div>
      <div className="ds-eyebrow text-[10px]">{LIVE_FLOW_LABEL[status]}</div>
    </div>
  );
}

function FlowParticle({ particle }: { particle: Particle }) {
  return (
    <span
      data-testid="flow-particle"
      className="absolute z-0 h-3.5 w-6 rounded-sm shadow"
      style={{
        top: particle.top, left: '12%', background: `var(--st-${particle.status}-bg)`,
        border: `1px solid var(--st-${particle.status}-border)`, animation: `flowMove ${particle.duration}ms linear forwards`,
      }}
    />
  );
}

function FlowLegend() {
  return (
    <div className="mt-3 flex flex-wrap gap-3 text-xs" style={{ color: 'var(--foreground-muted)' }}>
      {STATUS_VARS.map((status) => (
        <span key={status} className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-sm" style={{ background: `var(--st-${status}-bg)`, border: `1px solid var(--st-${status}-border)` }} />
          {LIVE_FLOW_LABEL[status]}
        </span>
      ))}
    </div>
  );
}

function FlowStyles() {
  return <style>{`@keyframes flowMove { 0% { left: 12%; opacity: 0; } 10% { opacity: 1; } 90% { opacity: 1; } 100% { left: 88%; opacity: 0; } }`}</style>;
}

export function LiveFlow({ counts }: { counts: Counts }) {
  const particles = useFlowParticles();
  return (
    <div className="relative overflow-hidden rounded-[10px] border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <FlowHeader />
      <FlowCanvas counts={counts} particles={particles} />
      <FlowLegend />
      <FlowStyles />
    </div>
  );
}
