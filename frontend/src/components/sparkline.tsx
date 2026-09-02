type Props = {
  values: number[];
  w?: number;
  h?: number;
  color?: string;
};

export function Sparkline({ values, w = 84, h = 28, color = 'currentColor' }: Props) {
  if (values.length === 0) return null;
  const max = Math.max(...values, 1);
  // A polyline needs at least two points; with a single value, fall back to a
  // dot so the user sees something meaningful instead of an empty SVG.
  if (values.length === 1) {
    const cy = h - (values[0] / max) * h;
    return (
      <svg width={w} height={h} role="img" aria-label="tendência">
        <circle cx={w / 2} cy={cy} r="1.5" fill={color} />
      </svg>
    );
  }
  const step = w / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={w} height={h} role="img" aria-label="tendência">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
