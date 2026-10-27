import { useEffect, useState } from 'react';

import { fetchBuildJson, getLatest, type Latest } from '../lib/data';
import { int, pct, when } from '../lib/format';
import { Badge, Card, Loading, Problem, Td, Th } from './ui';

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
}

function statusTone(status: string): 'good' | 'warn' | 'bad' | 'muted' {
  if (status === 'pass') return 'good';
  if (status === 'warn') return 'warn';
  if (status === 'fail' || status === 'error') return 'bad';
  return 'muted';
}

export default function Health() {
  const [health, setHealth] = useState<HealthFile | null>(null);
  const [latest, setLatest] = useState<Latest | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [showAllChecks, setShowAllChecks] = useState(false);

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

  return (
    <div className="grid gap-6">
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
          <div className="overflow-x-auto">
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

      <Card title="Last ingest run per source and league" id="ingest">
        <div className="overflow-x-auto">
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

      <Card title="Reconciliation: league stats API against ESPN" id="reconciliation">
        <div className="overflow-x-auto">
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
