import { useEffect, useState } from 'react';

import { buildHref, getLatest, type Latest, type League } from '../lib/data';
import { currentLeague, LEAGUE_LABEL } from '../lib/league';
import { Card, Loading, Problem, Td, Th } from './ui';

export const NOTEBOOKS = [
  {
    name: '01_board_backtest',
    title: 'Board backtest',
    blurb:
      'The board replayed before and during past seasons from the games before each day: how many of its top players finished on top, against last season’s numbers and the season to date.',
  },
  {
    name: '02_streamer_signals',
    title: 'Streamer signals',
    blurb: 'Every Monday of past seasons: which Streamers column, sorted on, finds the free agents who produce most over the next seven days.',
  },
  {
    name: '03_game_context',
    title: 'Game context',
    blurb:
      'Whether back-to-backs, travel, altitude and the opponent change whether a regular plays and what they produce, and how often one missed game becomes several.',
  },
  {
    name: '04_data_quality',
    title: 'Data quality scorecard',
    blurb: 'Source agreement, box scores that add up, shot charts against the box, lineups, links and freshness: a value, a threshold and a status for each.',
  },
  {
    name: '05_shooting',
    title: 'Shooting: what is sustainable',
    blurb: 'How many attempts it takes before a free-throw, three-point or field-goal percentage is more skill than luck, and what a shot is worth by zone.',
  },
] as const;

interface LeagueFindings {
  headline: string;
  facts: { label: string; value: string }[];
  table?: { columns: string[]; rows: (string | number | null)[][] };
  /** How much evidence the findings rest on, described by n_label. */
  n?: number;
  n_label?: string;
  /** The build cannot answer for this league yet: shown as accumulating, never as zeros. */
  insufficient_history?: boolean;
}

interface Findings {
  title: string;
  leagues: Partial<Record<League, LeagueFindings>>;
}

export default function Notebooks() {
  const [league] = useState<League>(() => currentLeague());
  const [latest, setLatest] = useState<Latest | null | undefined>(undefined);
  const [published, setPublished] = useState<Set<string>>(new Set());
  const [findings, setFindings] = useState<Record<string, Findings>>({});
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const l = await getLatest();
      if (!live) return;
      setLatest(l);
      if (!l) return;
      const r = await fetch(buildHref(l, 'notebooks/index.json'));
      if (!r.ok) return;
      const index = (await r.json()) as { files: string[] };
      const files = new Set(index.files);
      if (live) setPublished(files);
      const loaded: Record<string, Findings> = {};
      await Promise.all(
        NOTEBOOKS.filter((nb) => files.has(`${nb.name}.findings.json`)).map(async (nb) => {
          const f = await fetch(buildHref(l, `notebooks/${nb.name}.findings.json`));
          if (f.ok) loaded[nb.name] = (await f.json()) as Findings;
        }),
      );
      if (live) setFindings(loaded);
    })().catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, []);

  if (error) return <Problem error={error} />;
  if (latest === undefined) return <Loading what="the notebooks" />;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6" data-testid="notebooks">
      {NOTEBOOKS.map((nb) => {
        const html = `${nb.name}.html`;
        const ready = latest !== null && published.has(html);
        const f = findings[nb.name]?.leagues[league];
        return (
          <Card key={nb.name} title={nb.title} id={nb.name}>
            <p className="text-sm text-muted">{nb.blurb}</p>
            {f?.insufficient_history ? (
              <div className="mt-3 grid gap-1" data-testid="findings-accumulating">
                <p className="text-sm font-medium">Accumulating: not enough history in this build</p>
                <p className="text-sm text-muted">{f.headline}</p>
              </div>
            ) : f ? (
              <div className="mt-3 grid gap-3" data-testid="findings">
                <p className="text-base font-medium">{f.headline}</p>
                {f.n !== undefined && f.n > 0 && (
                  <p className="text-xs text-muted" data-testid="findings-n">
                    Based on {f.n.toLocaleString('en-US')} {f.n_label ?? 'observations'}.
                  </p>
                )}
                <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  {f.facts.map((fact) => (
                    <div key={fact.label} className="flex justify-between gap-3 border-b border-line py-1">
                      <dt className="text-muted">{fact.label}</dt>
                      <dd className="text-right">{fact.value}</dd>
                    </div>
                  ))}
                </dl>
                {f.table && f.table.rows.length > 0 && (
                  <div className="table-scroll max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="Scrollable table">
                    <table className="w-full text-sm">
                      <thead>
                        <tr>
                          {f.table.columns.map((c, i) => (
                            <Th key={c} right={i > 0}>
                              {c}
                            </Th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {f.table.rows.map((row, i) => (
                          <tr key={i} className="border-t border-line">
                            {row.map((v, j) => (
                              <Td key={j} right={j > 0}>
                                {v === null ? '–' : String(v)}
                              </Td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted" data-testid="notebook-pending">
                {ready ? `No ${LEAGUE_LABEL[league]} findings in this build.` : 'Not rendered for this build yet.'}
              </p>
            )}
            {ready && latest && (
              <a href={buildHref(latest, `notebooks/${html}`)} className="mt-3 inline-block text-sm underline underline-offset-4">
                Open the full notebook (both leagues, with charts)
              </a>
            )}
          </Card>
        );
      })}
    </div>
  );
}
