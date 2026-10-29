import { useEffect, useMemo, useState } from 'react';

import { fetchBuildJson, getLatest, type League } from '../lib/data';
import { day, fmt, pct } from '../lib/format';
import { currentLeague, LEAGUE_LABEL } from '../lib/league';
import { eligibleAt, POSITION_LETTERS, type PositionLetter, sortRows, type SortDir, toggle } from '../lib/players';
import { href } from '../lib/site';
import { Card, Chip, InjuryTag, Loading, Note, Problem, Signed, SortTh, Td, Th } from './ui';

interface StreamerRow {
  player_id: string;
  full_name: string | null;
  position: string | null;
  team_id: string | null;
  team_abbreviation: string | null;
  season: string;
  season_complete: boolean;
  games_next_7: number;
  last_game_date: string | null;
  games_season: number | null;
  minutes_season: number | null;
  minutes_avg_5: number | null;
  minutes_trend: number | null;
  minutes_baseline: number | null;
  value_baseline: number | null;
  season_z_total: number | null;
  last_10_z_total: number | null;
  value_trend: number | null;
  points_avg_5: number | null;
  rebounds_total_avg_5: number | null;
  assists_avg_5: number | null;
  steals_avg_5: number | null;
  blocks_avg_5: number | null;
  three_pointers_made_avg_5: number | null;
  field_goal_pct_5: number | null;
  free_throw_pct_5: number | null;
  injury_status: string | null;
  injury_group: string | null;
  [key: string]: unknown;
}

interface Game {
  game_id: string;
  game_date: string;
  days_ahead: number;
  game_type: string;
  home_team_id: string;
  home_team_tricode: string;
  away_team_id: string;
  away_team_tricode: string;
}

interface Team {
  league: string;
  season: string;
  team_id: string;
  abbreviation: string;
}

const PAGE = 50;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekday(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

function WeekGrid({ games, teams, start }: { games: Game[]; teams: string[]; start: string }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const byTeamDay = new Map<string, string>();
  const perDay = new Map<string, number>();
  for (const g of games) {
    if (g.days_ahead > 6) continue;
    byTeamDay.set(`${g.home_team_tricode}|${g.game_date}`, `v ${g.away_team_tricode}`);
    byTeamDay.set(`${g.away_team_tricode}|${g.game_date}`, `@ ${g.home_team_tricode}`);
    perDay.set(g.game_date, (perDay.get(g.game_date) ?? 0) + 2);
  }
  const counts = new Map(teams.map((t) => [t, days.filter((d) => byTeamDay.has(`${t}|${d}`)).length]));
  const ordered = [...teams].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
  const busiest = Math.max(0, ...days.map((d) => perDay.get(d) ?? 0));
  return (
    <div className="table-scroll max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="Scrollable table">
      <table className="w-full text-sm" data-testid="week-grid">
        <thead>
          <tr>
            <Th>Team</Th>
            <Th right>Games</Th>
            {days.map((d) => {
              const n = perDay.get(d) ?? 0;
              const light = n > 0 && n <= busiest / 2;
              return (
                <th key={d} scope="col" className="px-2 py-1.5 text-center text-xs font-medium whitespace-nowrap text-muted">
                  {weekday(d)} {d.slice(5).replace('-', '/')}
                  <div className={light ? 'font-semibold text-good' : ''} title={light ? 'Light day: fewer teams play, so a streamer fills a lineup spot more easily' : undefined}>
                    {n} teams{light ? ' · light' : ''}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {ordered.map((t) => (
            <tr key={t} className="border-t border-line">
              <Td>{t}</Td>
              <Td right>
                <strong>{counts.get(t) ?? 0}</strong>
              </Td>
              {days.map((d) => {
                const cell = byTeamDay.get(`${t}|${d}`);
                return (
                  <td key={d} className={`px-2 py-1.5 text-center text-xs whitespace-nowrap ${cell ? 'bg-accent/10 font-medium' : 'text-muted'}`}>
                    {cell ?? '·'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Streamers() {
  const [league] = useState<League>(() => currentLeague());
  const [rows, setRows] = useState<StreamerRow[] | null>(null);
  const [games, setGames] = useState<Game[]>([]);
  const [teams, setTeams] = useState<string[]>([]);
  const [start, setStart] = useState<string>(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<unknown>(null);
  const [positions, setPositions] = useState<Set<PositionLetter>>(new Set());
  const [minNext7, setMinNext7] = useState(0);
  const [hideOut, setHideOut] = useState(true);
  const [sortKey, setSortKey] = useState('minutes_trend');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    let live = true;
    Promise.all([
      fetchBuildJson<StreamerRow[]>(`streamers/${league}.json`),
      fetchBuildJson<Game[]>(`schedule/${league}.json`).catch(() => [] as Game[]),
      fetchBuildJson<Team[]>('dim_team.json'),
      getLatest(),
    ])
      .then(([s, g, t, latest]) => {
        if (!live) return;
        setRows(s);
        setGames(g);
        const latestSeason = t.filter((x) => x.league === league).reduce((m, x) => (x.season > m ? x.season : m), '');
        setTeams([...new Set(t.filter((x) => x.league === league && x.season === latestSeason).map((x) => x.abbreviation))]);
        // The grid starts on the build day: the schedule's days_ahead counts from it.
        const first = g.find((x) => x.days_ahead === 0)?.game_date ?? (g[0] ? addDays(g[0].game_date, -g[0].days_ahead) : latest?.created_at.slice(0, 10));
        if (first) setStart(first);
      })
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, [league]);

  const inWeek = games.some((g) => g.days_ahead <= 6);

  const list = useMemo(() => {
    const filtered = (rows ?? [])
      .filter((r) => eligibleAt(r.position, positions))
      .filter((r) => r.games_next_7 >= minNext7)
      .filter((r) => !hideOut || r.injury_group !== 'out');
    return sortRows(filtered, (r) => {
      if (sortKey === 'name') return r.full_name;
      const v = r[sortKey];
      return typeof v === 'number' ? v : null;
    }, sortDir);
  }, [rows, positions, minNext7, hideOut, sortKey, sortDir]);

  if (error) return <Problem error={error} />;
  if (!rows) return <Loading what="streamers" />;

  const season = rows[0]?.season ?? '';
  const complete = rows.length > 0 && rows.every((r) => r.season_complete);
  const sortBy = (key: string, dir: SortDir = 'desc') => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      setSortDir(dir);
    }
  };
  const col = (key: string, label: string, title?: string) => (
    <SortTh right active={sortKey === key} dir={sortDir} onClick={() => sortBy(key)} title={title}>
      {label}
    </SortTh>
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      {complete || !inWeek ? (
        <Note testid="season-note">
          No {LEAGUE_LABEL[league]} regular-season games in the next seven days
          {inWeek ? ' (playoff games only)' : ''}. The list below is who finished the {season} season strongly: their last five
          games against their baseline, the rest of the season blended with the one before.
        </Note>
      ) : (
        <Note testid="season-note">
          The next seven days of the {LEAGUE_LABEL[league]} schedule, and players whose last five games beat their baseline: their
          earlier {season} games, blended with last season, which is all there is early on. A team with four games, or a game on
          a light day, is worth more to a streamer.
        </Note>
      )}

      {inWeek && (
        <Card title="Games in the next 7 days" id="schedule">
          <WeekGrid games={games} teams={teams} start={start} />
        </Card>
      )}

      <Card title={complete || !inWeek ? 'Finished strong' : 'Trending up'} id="trending">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1" role="group" aria-label="Position">
            {POSITION_LETTERS.map((p) => (
              <Chip key={p} label={`Position ${p}`} checked={positions.has(p)} onChange={() => setPositions(toggle(positions, p))}>
                {p}
              </Chip>
            ))}
          </div>
          {inWeek && (
            <label className="text-sm">
              Min games next 7{' '}
              <select value={minNext7} onChange={(e) => setMinNext7(Number(e.target.value))} className="rounded border border-line bg-card px-2 py-1">
                {[0, 1, 2, 3, 4].map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={hideOut} onChange={(e) => setHideOut(e.target.checked)} />
            Hide players ruled out
          </label>
          <span className="text-sm text-muted">{list.length} players</span>
        </div>
        <div className="table-scroll max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="Scrollable table">
          <table className="w-full text-sm" data-testid="trending">
            <thead>
              <tr>
                <SortTh active={sortKey === 'name'} dir={sortDir} onClick={() => sortBy('name', 'asc')}>
                  Player
                </SortTh>
                <Th>Team</Th>
                <Th>Pos</Th>
                {inWeek && col('games_next_7', 'Next 7', 'Team games in the next seven days')}
                {col('minutes_avg_5', 'Min (5)', 'Minutes per game, last five games')}
                {col('minutes_baseline', 'Min (base)', 'Minutes per game before the last five games, blended with last season')}
                {col('minutes_trend', 'Min trend', 'Last five games minus the baseline')}
                {col('last_10_z_total', 'Value (10)', 'Total category z-score over the last ten games')}
                {col('value_trend', 'Value trend', 'Last-ten value minus the baseline (this season blended with last)')}
                {col('points_avg_5', 'PTS')}
                {col('rebounds_total_avg_5', 'REB')}
                {col('assists_avg_5', 'AST')}
                {col('steals_avg_5', 'STL')}
                {col('blocks_avg_5', 'BLK')}
                {col('three_pointers_made_avg_5', '3PM')}
                {col('field_goal_pct_5', 'FG%')}
                <Th>Last game</Th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, shown).map((r) => (
                <tr key={r.player_id} className="border-t border-line">
                  <Td>
                    <a href={href(`/p/${league}/${r.player_id}/`)} className="underline-offset-4 hover:underline">
                      {r.full_name ?? r.player_id}
                    </a>
                    <InjuryTag group={r.injury_group} status={r.injury_status} />
                  </Td>
                  <Td>{r.team_abbreviation ?? '–'}</Td>
                  <Td>{r.position ?? '–'}</Td>
                  {inWeek && <Td right>{r.games_next_7}</Td>}
                  <Td right>{fmt(r.minutes_avg_5)}</Td>
                  <Td right>{fmt(r.minutes_baseline)}</Td>
                  <Td right>
                    <Signed value={r.minutes_trend} digits={1} />
                  </Td>
                  <Td right>{fmt(r.last_10_z_total, 2)}</Td>
                  <Td right>
                    <Signed value={r.value_trend} />
                  </Td>
                  <Td right>{fmt(r.points_avg_5)}</Td>
                  <Td right>{fmt(r.rebounds_total_avg_5)}</Td>
                  <Td right>{fmt(r.assists_avg_5)}</Td>
                  <Td right>{fmt(r.steals_avg_5)}</Td>
                  <Td right>{fmt(r.blocks_avg_5)}</Td>
                  <Td right>{fmt(r.three_pointers_made_avg_5)}</Td>
                  <Td right>{pct(r.field_goal_pct_5)}</Td>
                  <Td>{day(r.last_game_date)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.length > shown && (
          <button type="button" onClick={() => setShown(shown + PAGE)} className="mt-3 rounded border border-line px-3 py-1 text-sm hover:bg-card">
            Show {Math.min(PAGE, list.length - shown)} more
          </button>
        )}
      </Card>
    </div>
  );
}
