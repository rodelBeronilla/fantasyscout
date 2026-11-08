import { useEffect, useState } from 'react';

import { fetchBuildJson, getLatest, type Latest, type League } from '../lib/data';
import { day, int, pct, when } from '../lib/format';
import { Badge, Card, Loading, Problem, Td, Th } from './ui';
import { freshness, type Incident, openIncidents, runbookHref } from '../lib/health-status';
import { fetchPlayerNotes, notesHealth, type PlayerNotes } from '../lib/player-notes';

const minutes = (seconds: number | null) => (seconds === null ? '–' : `${(seconds / 60).toFixed(1)} min`);

interface Gate {
  run_id: string;
  run_at: string;
  engine: string;
  git_sha: string;
  passed: boolean;
  error_failures: number;
  warn_failures: number;
  model_errors: number;
  reason: string;
}

interface Check {
  check_name: string;
  model: string;
  severity: string;
  status: string;
  failures: number;
  execution_time: number;
}

interface IngestRun {
  run_id: string;
  source: string;
  league: string;
  season: string;
  started_at: string;
  finished_at: string;
  games: number | null;
  landed: number | null;
  unchanged: number | null;
  skipped: number | null;
  failures: number | null;
  missing_at_source: number | null;
}

interface Reconciliation {
  league: string;
  season: string;
  player_games: number;
  matched: number;
  match_rate: number;
  played_player_games: number;
  played_matched: number;
  played_match_rate: number | null;
  exact: number;
  minor: number;
  conflict: number;
  conflict_rate: number | null;
}

/** One Build lakehouse run (ops.build_log; absent in older builds). */
interface BuildRun {
  run_id: string;
  run_url: string;
  run_at: string | null;
  finished_at: string;
  event: string;
  trigger_run_url: string | null;
  build_id: string | null;
  selected: string | null;
  light: boolean;
  outcome: string;
  gate_passed: boolean | null;
  gate_reason: string | null;
  error_checks: number | null;
  warn_checks: number | null;
  queue_seconds: number | null;
  build_seconds: number | null;
  total_seconds: number | null;
}

/** A request an ingest run could not land (ops.fetch_failures; absent in older builds). */
interface FetchFailure {
  run_id: string;
  source: string;
  league: string;
  season: string;
  started_at: string;
  kind: 'failed' | 'missing';
  endpoint: string;
  request_key: string;
  reason: string | null;
}

interface HealthFile {
  build_id: string;
  created_at: string;
  engine: string;
  git_sha: string;
  data_as_of: Record<string, string>;
  gate: Gate | null;
  gate_history: Gate[];
  checks: Check[];
  check_counts: Record<string, number>;
  ingest_runs: IngestRun[];
  reconciliation: Reconciliation[];
  row_counts: Record<string, number>;
  /** How fresh each source feed is (ops.feed_freshness; absent in older builds). */
  feeds?: Feed[];
  /** The recent Build lakehouse runs, newest first (ops.build_log; absent in older builds). */
  builds?: BuildRun[];
  /** Requests recent ingest runs could not land, newest first (ops.fetch_failures; absent in older builds). */
  fetch_failures?: FetchFailure[];
}

interface Feed {
  feed_key: string;
  league: string;
  feed: string;
  last_landed: string | null;
  age_days: number | null;
  max_age_days: number;
  status: 'fresh' | 'stale' | 'off_season' | 'never' | 'unconfigured';
  in_season?: boolean;
}

const FEED_STATUS: Record<Feed['status'], { label: string; tone: 'good' | 'warn' | 'bad' | 'muted' }> = {
  fresh: { label: 'Fresh', tone: 'good' },
  stale: { label: 'Stale', tone: 'bad' },
  unconfigured: { label: 'Not configured', tone: 'muted' },
  off_season: { label: 'Off season', tone: 'muted' },
  never: { label: 'Never landed', tone: 'warn' },
};

function statusTone(status: string): 'good' | 'warn' | 'bad' | 'muted' {
  if (status === 'pass') return 'good';
  if (status === 'warn') return 'warn';
  if (status === 'fail' || status === 'error') return 'bad';
  return 'muted';
}

const NOTE_TONE = { good: 'text-good', warn: 'font-semibold text-warn', muted: 'text-muted' } as const;

/** The status list's line on the player notes (#879). */
function NotesStatus({ status }: { status: ReturnType<typeof notesHealth> }) {
  return (
    <li data-testid="status-player-notes">
      <span className={NOTE_TONE[status.tone]}>{status.text}</span>
    </li>
  );
}

export default function Health() {
  const [health, setHealth] = useState<HealthFile | null>(null);
  const [latest, setLatest] = useState<Latest | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [showAllChecks, setShowAllChecks] = useState(false);
  // The open data incidents, read live from GitHub (null: not read; [] none open).
  const [incidents, setIncidents] = useState<Incident[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    openIncidents().then((list) => live && setIncidents(list));
    return () => {
      live = false;
    };
  }, []);
  // The player notes' files (#879): when they were last drafted, and whether the last run had the model.
  const [notes, setNotes] = useState<[League, PlayerNotes | null][] | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all((['nba', 'wnba'] as const).map(async (l): Promise<[League, PlayerNotes | null]> => [l, await fetchPlayerNotes(l)])).then((n) => live && setNotes(n));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([fetchBuildJson<HealthFile>('health.json'), getLatest()])
      .then(([h, l]) => {
        if (!live) return;
        setHealth(h);
        setLatest(l);
      })
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, []);

  if (error) return <Problem error={error} />;
  if (!health) return <Loading what="data health" />;

  const notable = health.checks.filter((c) => c.status !== 'pass');
  const checks = showAllChecks ? health.checks : notable;
  const lastRunBySource = new Map<string, IngestRun>();
  for (const r of health.ingest_runs) {
    const key = `${r.source}/${r.league}`;
    if (!lastRunBySource.has(key)) lastRunBySource.set(key, r);
  }

  // The morning's answers first (#418): on time, how the last build ended, what is open.
  const fresh = freshness(latest?.created_at ?? health.created_at, health.feeds);
  const lastBuild = health.builds?.[0];
  const lastFailed = !!lastBuild && lastBuild.outcome !== 'success';
  const tone = fresh.late || lastFailed || (incidents?.length ?? 0) > 0 ? 'border-bad' : 'border-good';
  const ago = fresh.hours < 1 ? `${Math.round(fresh.hours * 60)} minutes` : `${fresh.hours.toFixed(1)} hours`;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <section className={`rounded-lg border-2 ${tone} bg-card p-4`} aria-labelledby="status-h" data-testid="health-status">
        <h2 id="status-h" className="text-sm font-medium tracking-wide text-muted uppercase">
          Status
        </h2>
        <ul className="mt-2 grid gap-1 text-sm">
          <li data-testid="status-age">
            <span className={fresh.late ? 'font-semibold text-bad' : 'text-good'}>{fresh.late ? 'Late: ' : 'On time: '}</span>
            the live build was published {ago} ago; the limit is {fresh.limit} hours, {fresh.season}.{' '}
            <a href={runbookHref('Publish SLA and the watchdog')} className="underline underline-offset-4">
              Runbook
            </a>
          </li>
          {lastBuild && (
            <li data-testid="status-last-build">
              <span className={lastFailed ? 'font-semibold text-bad' : 'text-good'}>{lastFailed ? 'Last build failed: ' : 'Last build passed: '}</span>
              {lastBuild.light ? 'a light build' : 'a full build'}
              {lastBuild.finished_at ? ` that finished ${lastBuild.finished_at.slice(0, 16).replace('T', ' ')} UTC` : ''}
              {lastBuild.gate_reason ? `; ${lastBuild.gate_reason}` : ''}.{' '}
              {lastBuild.run_url && (
                <a href={lastBuild.run_url} className="underline underline-offset-4">
                  The run
                </a>
              )}
            </li>
          )}
          <li data-testid="status-incidents">
            {incidents === undefined ? (
              <span className="text-muted">Reading the open incidents…</span>
            ) : incidents === null ? (
              <span className="text-muted">
                The open incidents could not be read from GitHub just now;{' '}
                <a href="https://github.com/rodelBeronilla/fantasyscout/issues?q=is%3Aopen+label%3Adata-incident" className="underline underline-offset-4">
                  see them there
                </a>
                .
              </span>
            ) : incidents.length === 0 ? (
              <span className="text-good">No open data incidents.</span>
            ) : (
              <>
                <span className="font-semibold text-bad">
                  {incidents.length} open data incident{incidents.length === 1 ? '' : 's'}:
                </span>
                <ul className="mt-1 grid gap-0.5 pl-4">
                  {incidents.map((i) => (
                    <li key={i.number}>
                      <a href={i.html_url} className="underline underline-offset-4">
                        #{i.number} {i.title}
                      </a>{' '}
                      <span className="text-muted">since {i.created_at.slice(0, 10)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}{' '}
            <a href={runbookHref('Incident issues')} className="underline underline-offset-4">
              Runbook
            </a>
          </li>
          {notes && <NotesStatus status={notesHealth(notes, new Date())} />}
        </ul>
      </section>
      <Card title="This build" id={`build-${health.build_id}`}>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted">Build</dt>
            <dd className="font-mono text-xs" data-testid="health-build-id">
              {health.build_id}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Published</dt>
            <dd>{when(health.created_at)}</dd>
          </div>
          <div>
            <dt className="text-muted">Data as of</dt>
            <dd>
              {Object.entries(health.data_as_of).map(([league, d]) => (
                <span key={league} className="mr-3">
                  {league.toUpperCase()} {d}
                </span>
              ))}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Gate</dt>
            <dd>
              {health.gate ? (
                <Badge tone={health.gate.passed ? 'good' : 'bad'}>{health.gate.passed ? 'passed' : 'blocked'}</Badge>
              ) : (
                <Badge tone="muted">no gate recorded</Badge>
              )}{' '}
              <span className="text-muted">{health.gate?.reason}</span>
            </dd>
          </div>
          <div>
            <dt className="text-muted">Engine · commit</dt>
            <dd className="font-mono text-xs">
              {health.engine} · {health.git_sha.slice(0, 7)}
            </dd>
          </div>
          {latest?.rolled_back_from && (
            <div>
              <dt className="text-muted">Rolled back from</dt>
              <dd className="font-mono text-xs">{latest.rolled_back_from}</dd>
            </div>
          )}
        </dl>
      </Card>

      <Card title={`Checks (${int(health.check_counts.pass)} pass, ${int(health.check_counts.warn)} warn, ${int((health.check_counts.fail ?? 0) + (health.check_counts.error ?? 0))} fail)`} id="checks">
        {notable.length === 0 && !showAllChecks && <p className="text-sm text-muted">Every check passed in this build.</p>}
        {checks.length > 0 && (
          <div className="table-scroll max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="This build's checks">
            <table className="w-full text-sm" data-testid="checks">
              <thead>
                <tr>
                  <Th>Check</Th>
                  <Th>Model</Th>
                  <Th>Severity</Th>
                  <Th>Status</Th>
                  <Th right>Failing rows</Th>
                </tr>
              </thead>
              <tbody>
                {checks.map((c) => (
                  <tr key={c.check_name + c.model} className="border-t border-line">
                    <Td mono>{c.check_name}</Td>
                    <Td>{c.model}</Td>
                    <Td>{c.severity}</Td>
                    <Td>
                      <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                    </Td>
                    <Td right>{int(c.failures)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <button
          type="button"
          onClick={() => setShowAllChecks((v) => !v)}
          className="mt-3 rounded border border-line px-3 py-1 text-sm hover:bg-card"
        >
          {showAllChecks ? 'Show only flagged checks' : `Show all ${health.checks.length} checks`}
        </button>
      </Card>

      {(health.feeds ?? []).length > 0 && (
        <Card title="Source feeds" id="feeds">
          <p className="mb-2 text-xs"><a href={runbookHref('Run an ingest by hand')} className="underline underline-offset-4">Runbook: Run an ingest by hand</a></p>
          <p className="mb-2 text-sm text-muted">
            The newest day each feed landed, against how old it may get while the league is playing. A feed that stops keeps
            showing its last snapshot on the site, so a stale one is flagged here and in the checks.
          </p>
          <div className="table-scroll max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="Source feeds">
            <table className="w-full text-sm" data-testid="feeds">
              <thead>
                <tr>
                  <Th>Feed</Th>
                  <Th>League</Th>
                  <Th>Last landed</Th>
                  <Th right>Age (days)</Th>
                  <Th right>Allowed</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {[...(health.feeds ?? [])]
                  .sort((a, b) => a.league.localeCompare(b.league) || a.feed.localeCompare(b.feed))
                  .map((f) => (
                    <tr key={f.feed_key} className="border-t border-line">
                      <Td>{f.feed}</Td>
                      <Td>{f.league.toUpperCase()}</Td>
                      <Td>{f.last_landed ? day(f.last_landed) : '–'}</Td>
                      <Td right>{f.last_landed ? int(f.age_days ?? 0) : '–'}</Td>
                      <Td right>{int(f.max_age_days)}</Td>
                      <Td>
                        <Badge tone={FEED_STATUS[f.status]?.tone ?? 'muted'}>{FEED_STATUS[f.status]?.label ?? f.status}</Badge>
                      </Td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {health.fetch_failures && health.fetch_failures.length > 0 && (
        <Card title="Failed fetches" id="fetch-failures">
          <p className="mb-2 text-xs"><a href={runbookHref('Replay failed fetches')} className="underline underline-offset-4">Runbook: Replay failed fetches</a></p>
          <p className="mb-3 text-sm text-muted">
            Requests the recent ingest runs could not land, newest first: the endpoint and key to replay (runbook, &ldquo;Replay failed
            fetches&rdquo;) and why. A payload missing at the source is the source&apos;s gap, not ours.
          </p>
          <div className="table-scroll overflow-auto" tabIndex={0} role="region" aria-label="Failed fetches">
            <table className="w-full text-sm" data-testid="fetch-failures">
              <thead>
                <tr>
                  <Th>Run started</Th>
                  <Th>Source</Th>
                  <Th>Kind</Th>
                  <Th>Endpoint</Th>
                  <Th>Key</Th>
                  <Th>Reason</Th>
                </tr>
              </thead>
              <tbody>
                {health.fetch_failures.map((f, i) => (
                  <tr key={`${f.run_id}-${f.endpoint}-${f.request_key}-${i}`} className="border-t border-line">
                    <Td>{when(f.started_at)}</Td>
                    <Td>
                      {f.source} {f.league.toUpperCase()}
                    </Td>
                    <Td>
                      <Badge tone={f.kind === 'failed' ? 'bad' : 'muted'}>{f.kind}</Badge>
                    </Td>
                    <Td>{f.endpoint}</Td>
                    <Td>
                      <span className="font-mono text-xs">{f.request_key}</span>
                    </Td>
                    <Td>
                      <span className="text-xs text-muted">{f.reason ?? ''}</span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Last ingest run per source and league" id="ingest">
        <div className="table-scroll max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="Last ingest run per source and league">
          <table className="w-full text-sm" data-testid="ingest">
            <thead>
              <tr>
                <Th>Source</Th>
                <Th>League</Th>
                <Th>Season</Th>
                <Th>Finished</Th>
                <Th right>Games</Th>
                <Th right>Landed</Th>
                <Th right>Unchanged</Th>
                <Th right>Skipped</Th>
                <Th right>Failed</Th>
                <Th right>Missing at source</Th>
              </tr>
            </thead>
            <tbody>
              {[...lastRunBySource.values()].map((r) => (
                <tr key={r.run_id} className="border-t border-line">
                  <Td>{r.source}</Td>
                  <Td>{r.league.toUpperCase()}</Td>
                  <Td>{r.season}</Td>
                  <Td>{when(r.finished_at)}</Td>
                  <Td right>{int(r.games)}</Td>
                  <Td right>{int(r.landed)}</Td>
                  <Td right>{int(r.unchanged)}</Td>
                  <Td right>{int(r.skipped)}</Td>
                  <Td right>{r.failures ? <Badge tone="bad">{int(r.failures)}</Badge> : '0'}</Td>
                  <Td right>{int(r.missing_at_source)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {health.builds && health.builds.length > 0 && (
        <Card title="Build runs" id="builds">
          <p className="mb-2 text-xs"><a href={runbookHref('Build the lakehouse by hand')} className="underline underline-offset-4">Runbook: Build the lakehouse by hand</a></p>
          <p className="mb-3 text-sm text-muted">
            Each run of the Build lakehouse workflow: how long it queued for a runner and ran, what its gate decided, and the build it
            published. A light build follows the evening ingest and covers the feeds it landed.
          </p>
          <div className="table-scroll overflow-auto" tabIndex={0} role="region" aria-label="Build runs">
            <table className="w-full text-sm" data-testid="builds">
              <thead>
                <tr>
                  <Th>Finished</Th>
                  <Th>Run</Th>
                  <Th>Trigger</Th>
                  <Th>Gate</Th>
                  <Th>Build</Th>
                  <Th right>Queued</Th>
                  <Th right>dbt</Th>
                  <Th right>Total</Th>
                  <Th right>Warns</Th>
                </tr>
              </thead>
              <tbody>
                {health.builds.map((b) => (
                  <tr key={b.run_id} className="border-t border-line">
                    <Td>{when(b.finished_at)}</Td>
                    <Td>
                      {b.run_url ? (
                        <a href={b.run_url} className="underline-offset-4 hover:underline" rel="noopener">
                          {b.run_id}
                        </a>
                      ) : (
                        b.run_id
                      )}
                      {b.outcome !== 'success' && (
                        <>
                          {' '}
                          <Badge tone="bad">{b.outcome}</Badge>
                        </>
                      )}
                    </Td>
                    <Td>
                      {b.event}
                      {b.light && (
                        <>
                          {' '}
                          <Badge tone="muted">light</Badge>
                        </>
                      )}
                    </Td>
                    <Td>
                      {b.gate_passed === null ? (
                        <Badge tone="muted">none</Badge>
                      ) : (
                        <Badge tone={b.gate_passed ? 'good' : 'bad'}>{b.gate_passed ? 'passed' : 'blocked'}</Badge>
                      )}
                    </Td>
                    <Td>
                      <span className="font-mono text-xs">{b.build_id ?? '–'}</span>
                    </Td>
                    <Td right>{minutes(b.queue_seconds)}</Td>
                    <Td right>{minutes(b.build_seconds)}</Td>
                    <Td right>{minutes(b.total_seconds)}</Td>
                    <Td right>{b.warn_checks ?? '–'}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Reconciliation: league stats API against ESPN" id="reconciliation">
        <div className="table-scroll max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="Reconciliation">
          <table className="w-full text-sm" data-testid="reconciliation">
            <thead>
              <tr>
                <Th>League</Th>
                <Th>Season</Th>
                <Th right>Player-games</Th>
                <Th right>Matched</Th>
                <Th right>Played matched</Th>
                <Th right>Exact</Th>
                <Th right>Minor</Th>
                <Th right>Conflict</Th>
                <Th right>Conflict rate</Th>
              </tr>
            </thead>
            <tbody>
              {health.reconciliation.map((r) => (
                <tr key={`${r.league}-${r.season}`} className="border-t border-line">
                  <Td>{r.league.toUpperCase()}</Td>
                  <Td>{r.season}</Td>
                  <Td right>{int(r.player_games)}</Td>
                  <Td right>{pct(r.match_rate)}</Td>
                  <Td right>
                    {r.played_match_rate !== null && r.played_match_rate < 0.99 ? (
                      <Badge tone="warn">{pct(r.played_match_rate)}</Badge>
                    ) : (
                      pct(r.played_match_rate)
                    )}
                  </Td>
                  <Td right>{int(r.exact)}</Td>
                  <Td right>{int(r.minor)}</Td>
                  <Td right>{int(r.conflict)}</Td>
                  <Td right>{pct(r.conflict_rate)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Row counts" id="rows">
          <ul className="grid gap-1 text-sm">
            {Object.entries(health.row_counts).map(([name, n]) => (
              <li key={name} className="flex justify-between border-b border-line py-1">
                <span className="font-mono text-xs">{name}</span>
                <span className="tabular-nums">{int(n)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Gate history" id="gates">
          <ul className="grid gap-1 text-sm">
            {health.gate_history.map((g) => (
              <li key={g.run_id} className="flex items-center justify-between border-b border-line py-1">
                <span>{when(g.run_at)}</span>
                <span className="text-muted">
                  {g.error_failures} error · {g.warn_failures} warn
                </span>
                <Badge tone={g.passed ? 'good' : 'bad'}>{g.passed ? 'passed' : 'blocked'}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
