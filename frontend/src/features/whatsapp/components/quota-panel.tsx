import type { Instance } from '../schemas';

type Props = {
  instance: Instance;
};

/** Percentage threshold above which the quota bar turns amber/red. */
const WARN_THRESHOLD = 0.8;

function formatResetTime(resetAt: string | undefined): string {
  if (!resetAt) return '—';
  try {
    const d = new Date(resetAt);
    // Next reset is 24 h after the last reset
    const next = new Date(d.getTime() + 24 * 60 * 60 * 1000);
    return next.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

function formatWindow(
  start: number | undefined,
  end: number | undefined,
  enabled: boolean | undefined,
): string {
  if (enabled === false) return 'Janela desativada';
  if (start == null || end == null) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(start)}:00 – ${pad(end)}:00`;
}

export function QuotaPanel({ instance }: Props) {
  const { sentToday, dailySendLimit, sentTodayResetAt } = instance;
  // Anti-ban warm-up: while a number is warming, the cap actually enforced today
  // is `warmupEffectiveCap` (below the configured dailySendLimit), so the quota
  // bar must count against it — not the full limit.
  const warming = instance.warming === true && instance.warmupEffectiveCap != null;
  const displayLimit = warming
    ? (instance.warmupEffectiveCap as number)
    : dailySendLimit;
  const limit = displayLimit > 0 ? displayLimit : 1;
  const ratio = sentToday / limit;
  const pct = Math.min(ratio * 100, 100);
  const isWarning = ratio >= WARN_THRESHOLD;

  const barColor = isWarning ? 'bg-amber-500' : 'bg-emerald-500';
  const textColor = isWarning ? 'text-amber-600' : 'text-[var(--foreground-muted)]';

  const resetLabel = formatResetTime(sentTodayResetAt);
  const windowLabel = formatWindow(
    instance.sendWindowStartHour,
    instance.sendWindowEndHour,
    instance.sendWindowEnabled,
  );

  return (
    <div
      className="space-y-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2 text-xs"
      data-testid="quota-panel"
    >
      <div className="flex items-center justify-between">
        <span className="font-medium">Quota hoje</span>
        <span
          className={`tabular-nums font-semibold ${textColor}`}
          data-testid="quota-usage"
        >
          {sentToday} / {displayLimit}
          {isWarning && (
            <span
              className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-bold text-amber-700"
              data-testid="quota-warning-badge"
            >
              {ratio >= 1 ? 'LIMITE' : 'AVISO'}
            </span>
          )}
        </span>
      </div>

      {/* Progress bar */}
      <div
        className="h-1.5 w-full rounded-full bg-[var(--border)]"
        role="progressbar"
        aria-valuenow={sentToday}
        aria-valuemin={0}
        aria-valuemax={displayLimit}
        aria-label="Progresso de quota diária"
      >
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
          data-testid="quota-bar"
        />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[var(--foreground-muted)]">
        <span>
          <span className="opacity-60">Próximo reset:</span>{' '}
          <span data-testid="quota-reset">{resetLabel}</span>
        </span>
        <span>
          <span className="opacity-60">Janela:</span>{' '}
          <span data-testid="quota-window">{windowLabel}</span>
        </span>
      </div>

      {warming && (
        <div
          className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
          data-testid="quota-warmup"
        >
          Aquecimento: dia {instance.warmupDay} · limite hoje {displayLimit}/dia
        </div>
      )}
    </div>
  );
}
