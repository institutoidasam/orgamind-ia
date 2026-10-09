import { Sparkline } from './sparkline';

type Props = {
  tone?: 'brand' | 'neutral';
  label: string;
  value: number | string;
  meta?: string;
  /** Optional small suffix shown next to the value (e.g. "%") */
  suffix?: string;
  sparkline?: number[];
};

function KpiSparkline({ isBrand, values }: { isBrand: boolean; values?: number[] }) {
  if (!values?.length) return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute right-4 top-4 hidden opacity-70 sm:block"
      data-testid="kpi-sparkline"
      style={{ color: isBrand ? 'var(--brand-orange)' : 'var(--foreground-muted)' }}
    >
      <Sparkline values={values} />
    </div>
  );
}

function KpiValue({ value, suffix }: Pick<Props, 'value' | 'suffix'>) {
  return (
    <div
      className="mt-2 flex items-baseline gap-1 font-sans text-[30px] font-bold leading-none tracking-tight tabular-nums sm:pr-20"
      style={{ color: 'var(--brand-primary)' }}
    >
      <span>{value}</span>
      {suffix && (
        <span
          className="text-lg font-semibold tracking-normal"
          style={{ color: 'var(--foreground-muted)' }}
        >
          {suffix}
        </span>
      )}
    </div>
  );
}

export function KPIHero({ tone = 'neutral', label, value, meta, suffix, sparkline }: Props) {
  const isBrand = tone === 'brand';
  return (
    <div
      className="relative min-h-28 overflow-hidden rounded-[10px] border p-4"
      style={{
        background: 'var(--surface)',
        borderColor: 'var(--border)',
        borderTop: isBrand ? '3px solid var(--brand-orange)' : undefined,
        color: 'var(--foreground)',
      }}
    >
      <KpiSparkline isBrand={isBrand} values={sparkline} />
      <div
        className="text-[11px] font-medium leading-[1.35] sm:pr-20"
        style={{ color: 'var(--foreground-muted)' }}
      >
        {label}
      </div>
      <KpiValue value={value} suffix={suffix} />
      {meta && (
        <div
          className="mt-1 text-xs sm:pr-20"
          style={{ color: 'var(--foreground-muted)' }}
        >
          {meta}
        </div>
      )}
    </div>
  );
}
