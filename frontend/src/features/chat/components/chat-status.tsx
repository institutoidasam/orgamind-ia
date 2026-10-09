import { Check, CheckCheck, Clock, AlertTriangle } from 'lucide-react';

type TickEntry = { icon: React.ReactNode; title: string };

const STATUS_TICKS: Record<string, TickEntry> = {
  QUEUED: { icon: <Clock className="size-3" />, title: 'Na fila' },
  WAITING_INSTANCE: { icon: <Clock className="size-3" />, title: 'Aguardando conexão' },
  SENT: { icon: <Check className="size-3" />, title: 'Enviada' },
  DELIVERED: { icon: <CheckCheck className="size-3" />, title: 'Entregue' },
  READ: { icon: <CheckCheck className="size-3" style={{ color: 'var(--surface)' }} />, title: 'Lida' },
  FAILED: { icon: <AlertTriangle className="size-3" style={{ color: 'var(--st-failed-fg)' }} />, title: 'Falhou' },
  CANCELLED: { icon: <AlertTriangle className="size-3" />, title: 'Cancelada' },
};

// Defensive: unknown statuses (e.g. a new backend enum) must never crash a
// render via the global ErrorBoundary. Fall back to a neutral clock.
const UNKNOWN_TICK: TickEntry = { icon: <Clock className="size-3" />, title: '—' };

export function StatusTicks({ status }: { status: string }) {
  const t = STATUS_TICKS[status] ?? UNKNOWN_TICK;
  return <span title={t.title} className="inline-flex items-center">{t.icon}</span>;
}
