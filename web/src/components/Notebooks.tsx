import { useEffect, useState } from 'react';

import { buildHref, getLatest, type Latest } from '../lib/data';
import { Loading, Problem } from './ui';

export const NOTEBOOKS = [
  {
    file: '01_shot_profiles.html',
    title: 'Shot profiles',
    blurb: 'Zone efficiency against the league for the current WNBA season, and the highest-volume shooters zone by zone.',
  },
  {
    file: '02_reconciliation_audit.html',
    title: 'Reconciliation audit',
    blurb: 'How much of each season the second source covers, how often the sources agree, and which values differ when they do.',
  },
  {
    file: '03_fantasy_value_backtest.html',
    title: 'Fantasy value backtest',
    blurb: 'Did last season\u2019s z-score rank predict this season\u2019s value? Rank correlation per league and the biggest misses.',
  },
] as const;

export default function Notebooks() {
  const [latest, setLatest] = useState<Latest | null | undefined>(undefined);
  const [published, setPublished] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const l = await getLatest();
      if (!live) return;
      setLatest(l);
      if (!l) return;
      const r = await fetch(buildHref(l, 'notebooks/index.json'));
      if (r.ok) {
        const index = (await r.json()) as { files: string[] };
        if (live) setPublished(new Set(index.files));
      }
    })().catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, []);

  if (error) return <Problem error={error} />;
  if (latest === undefined) return <Loading what="the notebook list" />;

  return (
    <ul className="grid gap-4 sm:grid-cols-3" data-testid="notebooks">
      {NOTEBOOKS.map((nb) => {
        const ready = latest !== null && published.has(nb.file);
        return (
          <li key={nb.file} className="rounded-lg border border-line bg-card p-4">
            <h2 className="font-semibold">{nb.title}</h2>
            <p className="mt-1 text-sm text-muted">{nb.blurb}</p>
            {ready && latest ? (
              <a href={buildHref(latest, `notebooks/${nb.file}`)} className="mt-3 inline-block text-sm underline underline-offset-4">
                Open the rendered notebook
              </a>
            ) : (
              <p className="mt-3 text-sm text-muted" data-testid="notebook-pending">
                Not rendered for this build yet.
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
