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

export function KPIHero({ tone = 'neutral', label, value, meta, suffix, sparkline }: Props) {
  const isBrand = tone === 'brand';
  return (
    <div
      className="relative overflow-hidden rounded-xl p-5"
      style={{
        background: isBrand ? 'var(--gradient-brand)' : 'var(--surface)',
        color: isBrand ? 'white' : 'var(--foreground)',
        boxShadow: isBrand ? 'var(--shadow-md)' : 'var(--ring-soft)',
      }}
    >
      {sparkline && sparkline.length > 0 && (
        <div
          className="absolute right-3 top-3"
          style={{ color: isBrand ? 'rgba(255,255,255,0.55)' : 'var(--brand-purple)' }}
        >
          <Sparkline values={sparkline} />
        </div>
      )}
      <div
        className="text-[12px] font-medium uppercase tracking-wider"
        style={{ color: isBrand ? 'rgba(255,255,255,0.78)' : 'var(--foreground-muted)' }}
      >
        {label}
      </div>
      <div className="ds-display-lg mt-2 flex items-baseline gap-1.5">
        <span>{value}</span>
        {suffix && (
          <span
            className="text-2xl font-semibold tracking-normal"
            style={{ opacity: isBrand ? 0.78 : 0.5 }}
          >
            {suffix}
          </span>
        )}
      </div>
      {meta && (
        <div
          className="mt-1 text-xs"
          style={{ color: isBrand ? 'rgba(255,255,255,0.78)' : 'var(--foreground-muted)' }}
        >
          {meta}
        </div>
      )}
    </div>
  );
}
