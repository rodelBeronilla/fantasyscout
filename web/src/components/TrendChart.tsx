import * as Plot from '@observablehq/plot';
import { useEffect, useRef } from 'react';

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

/** Rolling averages over the season as lines, one per series, drawn with Observable Plot. */
export default function TrendChart({ rows, series, title }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const data = rows.flatMap((r) =>
      series.map((s) => ({ game: r.game_number, series: s.label, value: r[s.key] as number | null })),
    );
    const chart = Plot.plot({
      width: Math.min(640, host.clientWidth || 640),
      height: 220,
      marginLeft: 40,
      style: { background: 'transparent', color: 'currentColor', fontSize: '12px' },
      x: { label: 'Game', nice: true },
      y: { label: null, grid: true },
      color: { legend: true },
      marks: [
        Plot.ruleY([0]),
        Plot.line(data, { x: 'game', y: 'value', stroke: 'series', strokeWidth: 2, curve: 'monotone-x' }),
        Plot.dot(data, { x: 'game', y: 'value', stroke: 'series', r: 2 }),
      ],
    });
    host.replaceChildren(chart);
    return () => chart.remove();
  }, [rows, series]);
  return (
    <figure>
      <div ref={ref} role="img" aria-label={title} data-testid="trend-chart" />
      <figcaption className="mt-1 text-xs text-muted">{title}</figcaption>
    </figure>
  );
}
