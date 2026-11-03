import { useEffect, useState } from 'react';

import { buildHref, dataHref, getLatest, type Latest, type League } from '../lib/data';
import { currentLeague, LEAGUE_LABEL } from '../lib/league';
import { Card, Loading, Problem, Td, Th } from './ui';

const NOTEBOOKS = [
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
      'Whether back-to-backs, travel, altitude, the opponent, the referees and the betting line change whether a regular plays and what they produce, whether the line makes a better matchup, and how often one missed game becomes several.',
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
  {
    name: '07_teammate_absence',
    title: 'Teammate absence',
    blurb:
      'When a big-minutes or high-usage teammate is known to be out, how much the others’ minutes, usage and fantasy production rise, and whether adjusting the last ten games for it predicts the next week any better.',
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

/** One build's findings for a league, as the history keeps them (export/build.py findings_history). */
interface HistoryEntry {
  build_id: string;
  created_at: string;
  headline: string;
  n?: number | null;
  insufficient_history?: boolean;
  facts: Record<string, string | number | null>;
}
interface FindingsHistory {
  updated_at?: string;
  notebooks: Record<string, Record<string, HistoryEntry[]>>;
}

interface Findings {
  title: string;
  leagues: Partial<Record<League, LeagueFindings>>;
}

export default function Notebooks() {
  const [league] = useState<League>(() => currentLeague());
  const [latest, setLatest] = useState<Latest | null | undefined>(undefined);
  const [published, setPublished] = useState<Set<string>>(new Set());
  // A light build carries the last full build's notebooks (#530): say which build rendered them.
  const [carried, setCarried] = useState<{ from: string; at: string } | null>(null);
  const [history, setHistory] = useState<FindingsHistory | null>(null);
  const [findings, setFindings] = useState<Record<string, Findings>>({});
  const [error, setError] = useState<unknown>(null);
  // The cards render once the index and the findings are in, so they do not grow under the reader (#436).
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let live = true;
    // The history outlives the kept builds; an older deployment has none.
    fetch(dataHref('notebooks/findings-history.json'))
      .then((r) => (r.ok ? (r.json() as Promise<FindingsHistory>) : null))
      .then((h) => live && setHistory(h))
      .catch(() => live && setHistory(null));
    (async () => {
      const l = await getLatest();
      if (!live) return;
      setLatest(l);
      if (!l) return setSettled(true);
      const r = await fetch(buildHref(l, 'notebooks/index.json'));
      if (!r.ok) return setSettled(true);
      const index = (await r.json()) as { files: string[]; carried_from?: string; carried_from_created_at?: string };
      const files = new Set(index.files);
      if (live) setPublished(files);
      if (live && index.carried_from) setCarried({ from: index.carried_from, at: index.carried_from_created_at ?? '' });
      const loaded: Record<string, Findings> = {};
      await Promise.all(
        NOTEBOOKS.filter((nb) => files.has(`${nb.name}.findings.json`)).map(async (nb) => {
          const f = await fetch(buildHref(l, `notebooks/${nb.name}.findings.json`));
          if (f.ok) loaded[nb.name] = (await f.json()) as Findings;
        }),
      );
      if (live) {
        setFindings(loaded);
        setSettled(true);
      }
    })().catch((e: unknown) => {
      if (live) {
        setError(e);
        setSettled(true);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  if (error) return <Problem error={error} />;
  if (latest === undefined || !settled) return <Loading what="the notebooks" />;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6" data-testid="notebooks">
      {carried && (
        <p className="text-sm text-muted" data-testid="notebooks-carried">
          Rendered with the full build of {carried.at ? `${carried.at.slice(0, 16).replace('T', ' ')} UTC` : carried.from}. The evening build
          refreshes the injury reports and the board; the notebooks run again with the next morning&apos;s full build.
        </p>
      )}
      {NOTEBOOKS.map((nb) => {
        const html = `${nb.name}.html`;
        const ready = latest !== null && published.has(html);
        const f = findings[nb.name]?.leagues[league];
        const past = (history?.notebooks[nb.name]?.[league] ?? []).filter((e) => !e.insufficient_history).slice(-8).reverse();
        return (
          <Card key={nb.name} title={nb.title} id={nb.name}>
            <p className="text-sm text-muted">{nb.blurb}</p>
            {past.length > 1 && (
              <details className="mt-2 text-sm" data-testid="findings-history">
                <summary className="cursor-pointer text-muted">
                  The last {past.length} builds&apos; findings
                </summary>
                <ol className="mt-1 grid gap-1">
                  {past.map((e) => (
                    <li key={e.build_id} className="flex flex-wrap items-baseline gap-x-3 border-b border-line py-1">
                      <span className="font-mono text-xs text-muted">{e.created_at.slice(0, 10)}</span>
                      <span>{e.headline}</span>
                    </li>
                  ))}
                </ol>
              </details>
            )}
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
                  <div className="table-scroll max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label={`${nb.title}: table`}>
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
