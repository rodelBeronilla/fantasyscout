/**
 * A read-only DuckDB in the browser over the current build's Parquet files, read over HTTP
 * range requests from the same origin. The engine (wasm and worker, tens of megabytes) is too
 * big for a static asset, so it is served from the data bucket under /data/vendor/ by the
 * deploy; same origin, so the Worker's CSP stays at 'self' plus 'wasm-unsafe-eval'.
 */
import { DataType } from 'apache-arrow';
import { useEffect, useRef, useState } from 'react';

import { absoluteBuildUrl, dataHref, getLatest, getManifest, type Latest, type Manifest } from '../lib/data';

declare const __DUCKDB_VERSION__: string;
export const DUCKDB_VERSION: string = __DUCKDB_VERSION__;

/** Where the deploy puts the engine files (scripts/vendor-duckdb.mjs mirrors this locally). */
export function duckdbFile(name: string): string {
  return dataHref(`vendor/duckdb-wasm/${DUCKDB_VERSION}/${name}`);
}
import { href } from '../lib/site';
import { Loading, Problem, Td, Th } from './ui';

type DuckModule = typeof import('@duckdb/duckdb-wasm');
type Connection = import('@duckdb/duckdb-wasm').AsyncDuckDBConnection;

export const SAVED_QUERIES: { title: string; sql: string }[] = [
  {
    title: 'Top usage by minutes, current WNBA season',
    sql: `select p.full_name, g.team_tricode, count(*) as games,
  round(avg(g.minutes), 1) as minutes_pg, round(avg(g.usage_percentage), 3) as usage_pct
from fct_player_game g
join dim_player p on p.league = g.league and p.stats_player_id = g.player_id and p.is_current
where g.league = 'wnba' and g.season = (select max(season) from fct_player_game where league = 'wnba') and g.played
group by 1, 2 having count(*) >= 5
order by minutes_pg desc limit 20`,
  },
  {
    title: 'Shot zone efficiency vs league, current WNBA season',
    sql: `select shot_zone_basic as zone, count(*) as attempts,
  round(100.0 * sum(case when shot_made then 1 else 0 end) / count(*), 1) as fg_pct
from fct_shot
where league = 'wnba' and season = (select max(season) from fct_shot where league = 'wnba')
group by 1 order by attempts desc`,
  },
  {
    title: 'Reconciliation conflicts by team',
    sql: `select g.league, g.season, g.team_tricode, count(*) as player_games,
  sum(case when g.source_agreement = 'conflict' then 1 else 0 end) as conflicts
from fct_player_game g
group by 1, 2, 3 having conflicts > 0
order by conflicts desc limit 25`,
  },
  {
    title: 'The board: top 20 by total z-score',
    sql: `select rank_total, player_id, team_abbreviation, position, round(value_total, 2) as value_total
from mart_board where league = 'wnba' order by rank_total limit 20`,
  },
  {
    title: 'Team pace and ratings, current season',
    sql: `select team_abbreviation, count(*) as games,
  round(avg(pace), 1) as pace, round(avg(offensive_rating), 1) as ortg,
  round(avg(defensive_rating), 1) as drtg, round(avg(net_rating), 1) as net
from fct_team_game
where league = 'wnba' and season = (select max(season) from fct_team_game where league = 'wnba')
group by 1 order by net desc`,
  },
  {
    title: 'Triple-doubles',
    sql: `select g.game_date, g.league, p.full_name, g.points, g.rebounds_total, g.assists
from fct_player_game g
join dim_player p on p.league = g.league and p.stats_player_id = g.player_id and p.is_current
where g.points >= 10 and g.rebounds_total >= 10 and g.assists >= 10
order by g.game_date desc limit 50`,
  },
  {
    title: 'Best free-throw shooters on volume',
    sql: `select p.full_name, g.league, g.season,
  sum(g.free_throws_made) as ftm, sum(g.free_throws_attempted) as fta,
  round(100.0 * sum(g.free_throws_made) / sum(g.free_throws_attempted), 1) as ft_pct
from fct_player_game g
join dim_player p on p.league = g.league and p.stats_player_id = g.player_id and p.is_current
group by 1, 2, 3 having fta >= 100 order by ft_pct desc limit 20`,
  },
  {
    title: 'Games per fantasy week',
    sql: `select d.fantasy_week, count(distinct g.game_id) as games
from dim_game g join dim_date d on d.date_day = g.game_date
where g.league = 'wnba' and g.season = (select max(season) from dim_game where league = 'wnba')
group by 1 order by 1`,
  },
  {
    title: 'Players who changed teams (stints)',
    sql: `select league, full_name, count(*) as stints, min(valid_from) as first_game, max(valid_from) as last_move
from dim_player group by 1, 2 having count(*) > 1 order by stints desc, last_move desc limit 30`,
  },
  {
    title: 'The last build’s checks',
    sql: `select check_name, model, severity, status, failures
from test_results
where run_id = (select run_id from publish_gate order by run_at desc limit 1) and resource_type = 'test'
order by status, severity, check_name`,
  },
];

async function loadDuckDB(): Promise<DuckModule> {
  return import('@duckdb/duckdb-wasm');
}

async function openDatabase(latest: Latest, manifest: Manifest): Promise<{ conn: Connection; views: string[] }> {
  const duckdb = await loadDuckDB();
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: duckdbFile('duckdb-mvp.wasm'), mainWorker: duckdbFile('duckdb-browser-mvp.worker.js') },
    eh: { mainModule: duckdbFile('duckdb-eh.wasm'), mainWorker: duckdbFile('duckdb-browser-eh.worker.js') },
  });
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const conn = await db.connect();

  // One view per exported table; the partitioned facts read a list of files.
  const views: string[] = [];
  for (const [table, info] of Object.entries(manifest.tables)) {
    const name = table.split('.')[1] ?? table;
    const parquet = info.files.filter((f) => f.endsWith('.parquet'));
    if (!parquet.length) continue;
    const urls = parquet.map((f) => `'${absoluteBuildUrl(latest, f)}'`).join(', ');
    await conn.query(`create view ${name} as select * from read_parquet([${urls}])`);
    views.push(name);
  }
  return { conn, views: views.sort() };
}

function Console() {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [error, setError] = useState<unknown>(null);
  const [views, setViews] = useState<string[]>([]);
  const [sql, setSql] = useState(SAVED_QUERIES[0]?.sql ?? '');
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const connRef = useRef<Connection | null>(null);

  useEffect(() => {
    let live = true;
    setState('loading');
    (async () => {
      const latest = await getLatest();
      const manifest = await getManifest();
      if (!latest || !manifest) throw new (await import('../lib/data')).NoBuildError();
      const { conn, views } = await openDatabase(latest, manifest);
      if (!live) return;
      connRef.current = conn;
      setViews(views);
      setState('ready');
    })().catch((e: unknown) => {
      if (!live) return;
      setError(e);
      setState('failed');
    });
    return () => {
      live = false;
    };
  }, []);

  const run = async (text: string) => {
    const conn = connRef.current;
    if (!conn) return;
    setQueryError(null);
    const started = performance.now();
    try {
      const result = await conn.query(text);
      const fields = result.schema.fields;
      setColumns(fields.map((f) => f.name));
      // Arrow hands dates and timestamps over as epoch milliseconds; show them as dates.
      const kinds = fields.map((f) => (DataType.isDate(f.type) ? 'date' : DataType.isTimestamp(f.type) ? 'ts' : ''));
      setRows(
        result
          .toArray()
          .slice(0, 500)
          .map((r) =>
            Object.values(r.toJSON()).map((v, i) => {
              if (v === null || v === undefined) return v;
              if (kinds[i] === 'date') return new Date(Number(v)).toISOString().slice(0, 10);
              if (kinds[i] === 'ts') return new Date(Number(v)).toISOString().replace('T', ' ').slice(0, 19);
              return typeof v === 'bigint' ? v.toString() : v;
            }),
          ),
      );
      setElapsed(performance.now() - started);
    } catch (e: unknown) {
      setQueryError(e instanceof Error ? e.message : String(e));
      setRows([]);
      setColumns([]);
    }
  };

  if (state === 'failed') return <Problem error={error} />;

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside>
        <h2 className="text-sm font-medium tracking-wide text-muted uppercase">Saved queries</h2>
        <ul className="mt-2 grid gap-1">
          {SAVED_QUERIES.map((q) => (
            <li key={q.title}>
              <button
                type="button"
                className="w-full rounded border border-line px-2 py-1 text-left text-sm hover:bg-card"
                onClick={() => {
                  setSql(q.sql);
                  void run(q.sql);
                }}
              >
                {q.title}
              </button>
            </li>
          ))}
        </ul>
        <h2 className="mt-4 text-sm font-medium tracking-wide text-muted uppercase">Tables</h2>
        <p className="mt-1 font-mono text-xs text-muted" data-testid="sql-views">
          {views.join(', ')}
        </p>
      </aside>
      <div>
        <label className="block text-sm">
          <span className="sr-only">SQL</span>
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            rows={8}
            spellCheck={false}
            className="w-full rounded border border-line bg-card p-2 font-mono text-sm"
            data-testid="sql-input"
          />
        </label>
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            disabled={state !== 'ready'}
            onClick={() => void run(sql)}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
            data-testid="sql-run"
          >
            Run
          </button>
          {state === 'loading' && <Loading what="DuckDB and the build's tables" />}
          {elapsed !== null && (
            <span className="text-sm text-muted" data-testid="sql-elapsed">
              {rows.length} row{rows.length === 1 ? '' : 's'} in {elapsed.toFixed(0)} ms
              {rows.length === 500 ? ' (first 500 shown)' : ''}
            </span>
          )}
        </div>
        {queryError && (
          <pre className="mt-2 overflow-x-auto rounded border border-bad p-2 text-xs text-bad" role="alert">
            {queryError}
          </pre>
        )}
        {columns.length > 0 && (
          <div className="mt-3 table-scroll max-h-[70vh] overflow-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="Scrollable table">
            <table className="w-full text-sm" data-testid="sql-results">
              <thead className="bg-card">
                <tr>
                  {columns.map((c) => (
                    <Th key={c}>{c}</Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-line">
                    {r.map((v, j) => (
                      <Td key={j} right={typeof v === 'number' || typeof v === 'bigint'}>
                        {v === null || v === undefined ? '' : String(v)}
                      </Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

type Access = 'checking' | 'owner' | 'signin' | 'closed';

/** What the sign-in came back with, from the Worker's redirect. */
function signInNote(params: URLSearchParams): string | null {
  switch (params.get('signin')) {
    case 'notowner': {
      const account = params.get('account') ?? '';
      return `That Yahoo account (id ${account}) is not the site's owner. If it is yours, set the repository variable OWNER_YAHOO_GUID to ${account} and re-run Deploy web.`;
    }
    case 'noid':
      return `Yahoo signed you in but did not say which account it was (it sent ${params.get('fields') || 'no fields'}).`;
    case 'yahooerror':
      return `Yahoo refused the sign-in: ${params.get('detail') ?? 'no reason given'}. If it names the scope, the Yahoo app needs the OpenID Connect permission.`;
    case 'failed':
      return 'The Yahoo sign-in did not complete; try again.';
    case 'unavailable':
      return 'Signing in is not set up on this site.';
    default:
      return null;
  }
}

/**
 * The console reads the full tables, which only the site's owner may load (ADR 0008): the Worker
 * serves the Parquet files to the owner, signed in with their Yahoo account, and to no one else.
 * Without the Worker (local development, the test server) there is nothing to sign in to, and the
 * console opens.
 */
export default function SqlConsole() {
  const [access, setAccess] = useState<Access>('checking');
  const params = new URLSearchParams(window.location.search);
  const note = signInNote(params);
  useEffect(() => {
    fetch(href('/api/owner/status'), { headers: { accept: 'application/json' } })
      .then((res) => (res.ok ? (res.json() as Promise<{ configured: boolean; owner: boolean }>) : Promise.reject(new Error(String(res.status)))))
      .then((s) => setAccess(s.owner ? 'owner' : s.configured ? 'signin' : 'closed'))
      .catch(() => setAccess('owner'));
  }, []);

  if (access === 'checking') return <Loading what="the console" />;
  if (access === 'closed') {
    return (
      <p className="rounded-lg border border-line bg-card p-4 text-sm" data-testid="console-private">
        The SQL console is private to the site&apos;s owner.
      </p>
    );
  }
  if (access === 'signin') {
    return (
      <div className="grid max-w-xl gap-3 rounded-lg border border-line bg-card p-4 text-sm" data-testid="owner-signin">
        <p>
          The console queries the full tables behind the site: every box score, play and shot. The sources&apos; terms keep a database like that off a
          public site, so it is open to the site&apos;s owner only. Everything derived from it, from the board to the notebooks, stays public.
        </p>
        {note && (
          <p role="alert" className="text-bad" data-testid="signin-note">
            {note}
          </p>
        )}
        <a href={href('/auth/owner/start')} className="justify-self-start rounded border border-accent bg-accent px-3 py-1 text-accent-fg">
          Sign in with Yahoo
        </a>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <Console />
      <a href={href('/auth/owner/logout')} className="justify-self-start text-xs text-muted underline underline-offset-4">
        Sign out
      </a>
    </div>
  );
}
