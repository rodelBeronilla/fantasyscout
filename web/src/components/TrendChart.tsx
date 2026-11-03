/**
 * Rolling averages over the season as lines on a plain SVG. Drawn here rather than with a
 * chart library so that nothing needs inline styles, which the site's policy does not allow.
 */
interface Point {
  game_number: number;
  game_date: string;
  [key: string]: unknown;
}

interface Props {
  rows: Point[];
  series: { key: string; label: string }[];
  title: string;
}

const TONES = ['stroke-accent', 'stroke-good', 'stroke-warn', 'stroke-bad'] as const;
const SWATCH = ['bg-accent', 'bg-good', 'bg-warn', 'bg-bad'] as const;

// wide enough to span the page without growing tall (#726)
const W = 960;
const H = 240;
const M = { top: 10, right: 64, bottom: 26, left: 36 };

function ticks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  // the top tick covers the largest value, so no line runs off the top of the chart (#726)
  if ((out.at(-1) ?? 0) < max) out.push(Number(((out.at(-1) ?? 0) + step).toFixed(6)));
  return out;
}

export default function TrendChart({ rows, series, title }: Props) {
  const xs = rows.map((r) => r.game_number);
  const xMin = Math.min(...xs, 1);
  const xMax = Math.max(...xs, 2);
  const values = rows.flatMap((r) => series.map((s) => r[s.key])).filter((v): v is number => typeof v === 'number');
  const yTicks = ticks(Math.max(...values, 1));
  const yMax = yTicks[yTicks.length - 1] ?? 1;
  const x = (g: number) => M.left + ((g - xMin) / Math.max(1, xMax - xMin)) * (W - M.left - M.right);
  const y = (v: number) => H - M.bottom - (v / yMax) * (H - M.top - M.bottom);
  const xTicks = ticks(xMax).filter((t) => t >= xMin);

  return (
    <figure>
      <ul className="mb-2 flex flex-wrap gap-3 text-xs" aria-hidden="true">
        {series.map((s, i) => (
          <li key={s.key} className="flex items-center gap-1">
            <span className={`inline-block h-2 w-3 rounded-sm ${SWATCH[i % SWATCH.length]}`} />
            {s.label}
          </li>
        ))}
      </ul>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} className="w-full" data-testid="trend-chart">
        <g className="text-line" stroke="currentColor" strokeWidth="1">
          {yTicks.map((t) => (
            <line key={t} x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
          ))}
        </g>
        <g className="fill-muted text-[11px]">
          {yTicks.map((t) => (
            <text key={t} x={M.left - 6} y={y(t) + 4} textAnchor="end">
              {t}
            </text>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={x(t)} y={H - 8} textAnchor="middle">
              {t}
            </text>
          ))}
          <text x={W - M.right} y={H - 8} textAnchor="end">
            game
          </text>
        </g>
        {series.map((s, i) => {
          const pts = rows
            .map((r) => (typeof r[s.key] === 'number' ? `${x(r.game_number).toFixed(1)},${y(r[s.key] as number).toFixed(1)}` : null))
            .filter(Boolean)
            .join(' ');
          return <polyline key={s.key} points={pts} fill="none" strokeWidth="2" className={TONES[i % TONES.length]} />;
        })}
        {/* each line's latest value at its end, so the chart reads without the axis (#726) */}
        <g className="fill-fg text-[11px]" data-testid="trend-last">
          {series.map((s) => {
            const last = [...rows].reverse().find((r) => typeof r[s.key] === 'number');
            if (!last) return null;
            const v = last[s.key] as number;
            return (
              <text key={s.key} x={x(last.game_number) + 4} y={y(v) + 4}>
                {s.label} {v.toFixed(1)}
              </text>
            );
          })}
        </g>
      </svg>
      <figcaption className="mt-1 text-xs text-muted">{title}</figcaption>
    </figure>
  );
}
