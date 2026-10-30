import { useEffect, useMemo, useState } from 'react';

import { downloadCsv, toCsv } from '../lib/csv';
import { fetchBuildJson, getLatest, type League } from '../lib/data';
import { CATEGORIES, CATEGORY_LABELS, day, fmt, pct } from '../lib/format';
import { currentLeague, LEAGUE_LABEL } from '../lib/league';
import { eligibleAt, POSITION_LETTERS, type PositionLetter, sortRows, type SortDir, toggle } from '../lib/players';
import { href } from '../lib/site';
import { useWatchlist } from '../lib/watchlist';
import { owners, useLeague } from '../lib/fantasy-league';
import { Card, Chip, InjuryTag, LineupTag, Loading, NewTeam, Note, Problem, Signed, SortTh, Star, Td, Th } from './ui';

interface StreamerRow {
  player_id: string;
  /** Today's role from the league's starting lineups (NBA): starter, bench or inactive. */
  lineup_role?: string | null;
  lineup_confirmed?: boolean | null;
  /** How widely ESPN leagues roster the player: most, many, some, few or rare. */
  ownership_bucket?: string | null;
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
  board_rank: number | null;
  board_value: number | null;
  is_new_team: boolean | null;
  prev_team_abbreviation: string | null;
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
  home_matchup: number | null;
  away_matchup: number | null;
  /** The betting line, where the sportsbooks have posted one (silver game_lines). */
  home_spread?: number | null;
  over_under?: number | null;
  home_implied_points?: number | null;
  away_implied_points?: number | null;
  /** Rest and travel (fct_team_game_context). */
  home_back_to_back?: boolean | null;
  away_back_to_back?: boolean | null;
  away_miles_travelled?: number | null;
  at_altitude?: boolean | null;
}

/** A team's side of a game in the week grid: the opponent, and the points the line implies. */
interface GridCell {
  label: string;
  implied: number | null;
  line: string | null;
  /** The second night of a back-to-back for this team. */
  backToBack: boolean;
  /** Played 4,000 feet up or more. */
  altitude: boolean;
  miles: number | null;
}

function lineText(g: Game): string | null {
  if (typeof g.over_under !== 'number' || typeof g.home_spread !== 'number') return null;
  const favourite = g.home_spread <= 0 ? g.home_team_tricode : g.away_team_tricode;
  const spread = g.home_spread === 0 ? 'even' : `${favourite} -${Math.abs(g.home_spread)}`;
  return `Over/under ${g.over_under}, ${spread}`;
}

/** A signing, waiver, trade or G League move (gold fct_transaction). */
interface Move {
  transaction_date: string;
  team_abbreviation: string | null;
  player_id: string | null;
  move_type: string;
  description: string;
}

const MOVE_LABEL: Record<string, string> = {
  signing: 'Signed',
  waive: 'Waived',
  trade: 'Trade',
  g_league: 'G League',
  recall: 'Recalled',
  suspension: 'Suspended',
  other: 'Other',
};

/** The league's moves of the last two weeks: who just got signed, waived, traded or sent down. */
function RecentMoves({ moves, league, start }: { moves: Move[]; league: League; start: string }) {
  const since = addDays(start, -14);
  const recent = moves.filter((m) => m.transaction_date >= since).slice(0, 30);
  if (!recent.length) return null;
  return (
    <Card title="Recent moves" id="moves">
      <p className="mb-2 text-xs text-muted">
        Signings, waivers, trades and G League moves of the last two weeks: a new role on a new team, or minutes opening up behind a player who left.
      </p>
      <ul className="grid gap-1 text-sm" data-testid="recent-moves">
        {recent.map((m) => (
          <li key={`${m.transaction_date}-${m.team_abbreviation}-${m.description}`} className="flex flex-wrap items-baseline gap-x-2">
            <span className="w-20 shrink-0 text-xs text-muted">{day(m.transaction_date)}</span>
            <span className="w-10 shrink-0 font-medium">{m.team_abbreviation ?? '–'}</span>
            <span className="rounded border border-line px-1 text-[10px] text-muted">{MOVE_LABEL[m.move_type] ?? m.move_type}</span>
            <span className="min-w-0 flex-1">
              {m.player_id ? (
                <a href={href(`/p/${league}/${m.player_id}/`)} className="underline-offset-4 hover:underline">
                  {m.description}
                </a>
              ) : (
                m.description
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

interface Team {
  league: string;
  season: string;
  team_id: string;
  abbreviation: string;
}

/** A streamer row with what the page works out from the schedule and the picked needs. */
interface Candidate extends StreamerRow {
  games_window: number;
  games_picked: number;
  fit: number | null;
  /** Average matchup over the window's games: value per game the opponents' defence and pace add. */
  matchup: number | null;
  /** Points the betting lines imply the team scores, averaged over the window's games with a line. */
  implied_points: number | null;
  /** Last-ten value per game over the window's games, plus each game's matchup. */
  window_value: number | null;
}

type Health = 'all' | 'no_out' | 'healthy';

const PAGE = 50;
const HORIZONS = [3, 7, 14];
// A league-sized pool on the board (teams x roster spots); players inside it are most likely rostered.
const ROSTERED = { nba: [0, 100, 156, 200], wnba: [0, 60, 100, 140] } as const;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekday(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

function WeekGrid({ games, teams, days, picked }: { games: Game[]; teams: string[]; days: string[]; picked: Set<string> }) {
  const inRange = new Set(days);
  const byTeamDay = new Map<string, GridCell>();
  const perDay = new Map<string, number>();
  for (const g of games) {
    if (!inRange.has(g.game_date)) continue;
    const line = lineText(g);
    const altitude = !!g.at_altitude;
    byTeamDay.set(`${g.home_team_tricode}|${g.game_date}`, {
      label: `v ${g.away_team_tricode}`,
      implied: g.home_implied_points ?? null,
      line,
      backToBack: !!g.home_back_to_back,
      altitude,
      miles: null,
    });
    byTeamDay.set(`${g.away_team_tricode}|${g.game_date}`, {
      label: `@ ${g.home_team_tricode}`,
      implied: g.away_implied_points ?? null,
      line,
      backToBack: !!g.away_back_to_back,
      altitude,
      miles: g.away_miles_travelled ?? null,
    });
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
                <th
                  key={d}
                  scope="col"
                  className={`px-2 py-1.5 text-center text-xs font-medium whitespace-nowrap ${picked.has(d) ? 'text-accent' : 'text-muted'}`}
                >
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
                  <td
                    key={d}
                    className={`px-2 py-1.5 text-center text-xs whitespace-nowrap ${cell ? 'bg-accent/10 font-medium' : 'text-muted'}`}
                    title={
                      cell
                        ? [
                            cell.line ? `${cell.line}: ${t} implied ${cell.implied} points` : null,
                            cell.backToBack ? 'Second night of a back-to-back: rest and minutes risk' : null,
                            cell.miles ? `${cell.miles} miles from the previous game` : null,
                            cell.altitude ? 'At altitude' : null,
                          ]
                            .filter(Boolean)
                            .join('. ') || undefined
                        : undefined
                    }
                  >
                    {cell?.label ?? '·'}
                    {cell?.backToBack && (
                      <span className="ml-1 rounded border border-warn px-0.5 text-[9px] font-semibold text-warn" data-testid="back-to-back">
                        B2B
                      </span>
                    )}
                    {cell && typeof cell.implied === 'number' && (
                      <div className="text-[10px] font-normal text-muted" data-testid="implied-points">
                        {Math.round(cell.implied)} pts
                      </div>
                    )}
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
  const [moves, setMoves] = useState<Move[]>([]);
  const [teams, setTeams] = useState<string[]>([]);
  const [start, setStart] = useState<string>(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<unknown>(null);
  const [horizon, setHorizon] = useState(7);
  const [pickedDays, setPickedDays] = useState<Set<string>>(new Set());
  const [needs, setNeeds] = useState<Set<string>>(new Set());
  const [positions, setPositions] = useState<Set<PositionLetter>>(new Set());
  const [team, setTeam] = useState('');
  const [minGames, setMinGames] = useState(0);
  const [minMinutes, setMinMinutes] = useState(0);
  const [health, setHealth] = useState<Health>('no_out');
  const [rosteredChoice, setRostered] = useState<number | null>(null);
  const [watchOnly, setWatchOnly] = useState(false);
  const [startersOnly, setStartersOnly] = useState(false);
  const [sortKey, setSortKey] = useState('minutes_trend');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [shown, setShown] = useState(PAGE);
  const { watched, toggleWatched } = useWatchlist(league);
  // With the league's rosters in, leave out exactly the players on them (-1); otherwise a board-rank cut.
  const [setup] = useLeague(league);
  const owner = useMemo(() => owners(setup), [setup]);
  const rostered = rosteredChoice ?? (owner.size ? -1 : 0);

  useEffect(() => {
    let live = true;
    Promise.all([
      fetchBuildJson<StreamerRow[]>(`streamers/${league}.json`),
      fetchBuildJson<Game[]>(`schedule/${league}.json`).catch(() => [] as Game[]),
      fetchBuildJson<Team[]>('dim_team.json'),
      getLatest(),
      // Older builds have no transactions file.
      fetchBuildJson<Move[]>(`transactions/${league}.json`).catch(() => [] as Move[]),
    ])
      .then(([s, g, t, latest, mv]) => {
        if (!live) return;
        setRows(s);
        setGames(g);
        setMoves(mv);
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

  const days = useMemo(() => Array.from({ length: horizon }, (_, i) => addDays(start, i)), [start, horizon]);
  const inWeek = games.some((g) => g.days_ahead <= 6);

  // Each team's game dates inside the window, and the matchup of each of those games.
  const { teamDates, teamMatchups, teamImplied } = useMemo(() => {
    const inRange = new Set(days);
    const dates = new Map<string, Set<string>>();
    const matchups = new Map<string, number[]>();
    const implied = new Map<string, number[]>();
    for (const g of games) {
      if (!inRange.has(g.game_date)) continue;
      for (const [id, mu, pts] of [
        [g.home_team_id, g.home_matchup, g.home_implied_points],
        [g.away_team_id, g.away_matchup, g.away_implied_points],
      ] as const) {
        if (!dates.has(id)) dates.set(id, new Set());
        dates.get(id)?.add(g.game_date);
        if (typeof mu === 'number') matchups.set(id, [...(matchups.get(id) ?? []), mu]);
        if (typeof pts === 'number') implied.set(id, [...(implied.get(id) ?? []), pts]);
      }
    }
    return { teamDates: dates, teamMatchups: matchups, teamImplied: implied };
  }, [games, days]);

  const candidates = useMemo<Candidate[]>(
    () =>
      (rows ?? []).map((r) => {
        const dates = (r.team_id && teamDates.get(r.team_id)) || new Set<string>();
        const parts = [...needs].map((c) => r[`last_10_${c}`]).filter((v): v is number => typeof v === 'number');
        const mus = (r.team_id && teamMatchups.get(r.team_id)) || [];
        const muSum = mus.reduce((s, v) => s + v, 0);
        const pts = (r.team_id && teamImplied.get(r.team_id)) || [];
        return {
          ...r,
          games_window: dates.size,
          games_picked: [...pickedDays].filter((d) => dates.has(d)).length,
          fit: needs.size && parts.length ? parts.reduce((s, v) => s + v, 0) : null,
          matchup: mus.length ? muSum / mus.length : null,
          implied_points: pts.length ? pts.reduce((s, v) => s + v, 0) / pts.length : null,
          window_value: r.last_10_z_total === null || !dates.size ? null : r.last_10_z_total * dates.size + muSum,
        };
      }),
    [rows, teamDates, teamMatchups, teamImplied, pickedDays, needs],
  );

  const list = useMemo(() => {
    const filtered = candidates
      .filter((r) => eligibleAt(r.position, positions))
      .filter((r) => !team || r.team_abbreviation === team)
      .filter((r) => r.games_window >= minGames)
      .filter((r) => (r.minutes_avg_5 ?? 0) >= minMinutes)
      .filter((r) => health === 'all' || (health === 'no_out' ? r.injury_group !== 'out' : !r.injury_group))
      .filter((r) =>
        rostered === -1
          ? !owner.has(r.player_id)
          : rostered === -2
            ? !['most', 'many', 'some'].includes(r.ownership_bucket ?? '')
            : !rostered || r.board_rank === null || r.board_rank > rostered,
      )
      .filter((r) => pickedDays.size === 0 || r.games_picked > 0)
      .filter((r) => !watchOnly || watched.has(r.player_id))
      .filter((r) => !startersOnly || r.lineup_role === 'starter');
    return sortRows(filtered, (r) => {
      if (sortKey === 'name') return r.full_name;
      const v = r[sortKey];
      return typeof v === 'number' ? v : null;
    }, sortDir);
  }, [candidates, positions, team, minGames, minMinutes, health, rostered, owner, pickedDays, watchOnly, watched, startersOnly, sortKey, sortDir]);

  if (error) return <Problem error={error} />;
  if (!rows) return <Loading what="streamers" />;

  const season = rows[0]?.season ?? '';
  const complete = rows.length > 0 && rows.every((r) => r.season_complete);
  const teamOptions = [...new Set(rows.map((r) => r.team_abbreviation).filter((t): t is string => !!t))].sort();
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
  const toggleNeed = (c: string) => {
    const next = toggle(needs, c);
    setNeeds(next);
    if (next.size) {
      setSortKey('fit');
      setSortDir('desc');
    } else if (sortKey === 'fit') setSortKey('minutes_trend');
  };
  const exportCsv = () => {
    const header = ['player', 'team', 'new_team_from', 'position', `games_next_${horizon}`, 'matchup', 'implied_team_points', 'window_value', 'games_on_picked_days', 'minutes_last_5', 'minutes_baseline', 'minutes_trend', 'value_last_10', 'value_trend', 'need_fit', 'board_rank', 'points', 'rebounds', 'assists', 'steals', 'blocks', 'threes', 'fg_pct', 'last_game'];
    const body = list.map((r) => [r.full_name, r.team_abbreviation, r.is_new_team ? r.prev_team_abbreviation : null, r.position, r.games_window, r.matchup, r.implied_points, r.window_value, r.games_picked, r.minutes_avg_5, r.minutes_baseline, r.minutes_trend, r.last_10_z_total, r.value_trend, r.fit, r.board_rank, r.points_avg_5, r.rebounds_total_avg_5, r.assists_avg_5, r.steals_avg_5, r.blocks_avg_5, r.three_pointers_made_avg_5, r.field_goal_pct_5, r.last_game_date]);
    downloadCsv(`fantasyscout-${league}-streamers.csv`, toCsv(header, body));
  };
  const select = 'rounded border border-line bg-card px-2 py-1';

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
          The {LEAGUE_LABEL[league]} schedule ahead, and players whose last five games beat their baseline: their earlier {season}{' '}
          games, blended with last season, which is all there is early on. Pick the days you have open lineup spots and the
          categories you need; a team with more games, or a game on a light day, is worth more to a streamer.
        </Note>
      )}

      {inWeek && (
        <Card title={`Games in the next ${horizon} days`} id="schedule">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1" role="radiogroup" aria-label="Window">
              {HORIZONS.map((h) => (
                <button
                  key={h}
                  type="button"
                  role="radio"
                  aria-checked={horizon === h}
                  onClick={() => {
                    setHorizon(h);
                    setPickedDays(new Set());
                  }}
                  className={`rounded-full border px-3 py-1 text-sm ${horizon === h ? 'border-accent bg-accent text-accent-fg' : 'border-line'}`}
                >
                  {h} days
                </button>
              ))}
            </div>
            <fieldset className="flex flex-wrap items-center gap-1" data-testid="open-days">
              <legend className="sr-only">Open lineup days</legend>
              <span className="mr-1 text-xs text-muted">Open days:</span>
              {days.map((d) => (
                <Chip key={d} label={`Open on ${d}`} checked={pickedDays.has(d)} onChange={() => setPickedDays(toggle(pickedDays, d))}>
                  {weekday(d)} {d.slice(8)}
                </Chip>
              ))}
            </fieldset>
          </div>
          <WeekGrid games={games} teams={teams} days={days} picked={pickedDays} />
        </Card>
      )}

      <Card title={complete || !inWeek ? 'Finished strong' : 'Trending up'} id="trending">
        <div className="mb-3 grid gap-3">
          <fieldset className="flex flex-wrap items-center gap-1" data-testid="needs">
            <legend className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Categories you need (rank by last-ten value in them)</legend>
            {CATEGORIES.map((c) => (
              <Chip key={c} label={`Need ${CATEGORY_LABELS[c]}`} checked={needs.has(c)} onChange={() => toggleNeed(c)}>
                {CATEGORY_LABELS[c]}
              </Chip>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-center gap-3" data-testid="streamer-filters">
            <div className="flex items-center gap-1" role="group" aria-label="Position">
              {POSITION_LETTERS.map((p) => (
                <Chip key={p} label={`Position ${p}`} checked={positions.has(p)} onChange={() => setPositions(toggle(positions, p))}>
                  {p}
                </Chip>
              ))}
            </div>
            <label className="text-sm">
              <span className="sr-only">Team</span>
              <select value={team} onChange={(e) => setTeam(e.target.value)} className={select}>
                <option value="">All teams</option>
                {teamOptions.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            {inWeek && (
              <label className="text-sm">
                Min games next {horizon}{' '}
                <select value={minGames} onChange={(e) => setMinGames(Number(e.target.value))} className={select}>
                  {[0, 1, 2, 3, 4, 5, 6].filter((g) => g <= horizon).map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="text-sm" title="Minutes per game over the last five games">
              Min MPG (5){' '}
              <select value={minMinutes} onChange={(e) => setMinMinutes(Number(e.target.value))} className={select}>
                {[0, 10, 15, 20, 25].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="sr-only">Health</span>
              <select value={health} onChange={(e) => setHealth(e.target.value as Health)} className={select}>
                <option value="all">Everyone</option>
                <option value="no_out">Hide players ruled out</option>
                <option value="healthy">Healthy only</option>
              </select>
            </label>
            <label className="text-sm" title="Leave out players ranked inside this many on the board: in a league that size they are most likely rostered">
              Likely available{' '}
              <select value={rostered} onChange={(e) => setRostered(Number(e.target.value))} className={select}>
                {owner.size > 0 && <option value={-1}>not on a roster in my league</option>}
                {rows.some((r) => r.ownership_bucket) && <option value={-2}>rostered in under 10% of ESPN leagues</option>}
                {ROSTERED[league].map((n) => (
                  <option key={n} value={n}>
                    {n ? `outside the top ${n}` : 'everyone'}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={watchOnly} onChange={(e) => setWatchOnly(e.target.checked)} />
              Watchlist only ({watched.size})
            </label>
            {rows.some((r) => r.lineup_role) && (
              <label className="flex items-center gap-2 text-sm" title="From the league's starting lineups for today's games (NBA)">
                <input type="checkbox" checked={startersOnly} onChange={(e) => setStartersOnly(e.target.checked)} />
                Starting today
              </label>
            )}
            <span className="text-sm text-muted">{list.length} players</span>
            <button type="button" onClick={exportCsv} className="rounded border border-line px-3 py-1 text-sm hover:bg-card" data-testid="streamers-csv">
              Export CSV
            </button>
          </div>
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
                {inWeek && col('games_window', `Next ${horizon}`, `Team games in the next ${horizon} days`)}
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
                {needs.size > 0 && col('fit', 'Need fit', 'Last-ten z-score summed over the categories you need')}
                {pickedDays.size > 0 && col('games_picked', 'Open days', 'Games on the days you have open')}
                {inWeek && col('matchup', 'Matchup', 'Average value per game the opponents add or take away in this window: their defence and the expected pace (small: about 0.2 for one standard deviation of defence)')}
                {inWeek && col('implied_points', 'Team pts', 'Points the betting lines imply the team scores, per game in the window that has a line: a high-scoring game means more counting stats')}
                {inWeek && col('window_value', 'Window value', 'Last-ten value per game times games in the window, plus each game’s matchup')}
                {col('board_rank', 'Board #', 'Rank on the board; inside a league-sized pool usually means rostered')}
                <Th>Last game</Th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, shown).map((r) => (
                <tr key={r.player_id} className="border-t border-line">
                  <Td>
                    <span className="flex items-center gap-1 whitespace-nowrap">
                      <Star on={watched.has(r.player_id)} label={r.full_name ?? r.player_id} onToggle={() => toggleWatched(r.player_id)} />
                      <a href={href(`/p/${league}/${r.player_id}/`)} className="underline-offset-4 hover:underline">
                        {r.full_name ?? r.player_id}
                      </a>
                      {r.is_new_team && <NewTeam from={r.prev_team_abbreviation} />}
                      <LineupTag role={r.lineup_role} confirmed={r.lineup_confirmed} />
                      <InjuryTag group={r.injury_group} status={r.injury_status} />
                    </span>
                  </Td>
                  <Td>{r.team_abbreviation ?? '–'}</Td>
                  <Td>{r.position ?? '–'}</Td>
                  {inWeek && <Td right>{r.games_window}</Td>}
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
                  {needs.size > 0 && (
                    <Td right>
                      <Signed value={r.fit} />
                    </Td>
                  )}
                  {pickedDays.size > 0 && (
                    <Td right>
                      {r.games_picked}/{pickedDays.size}
                    </Td>
                  )}
                  {inWeek && (
                    <Td right>
                      <Signed value={r.matchup} />
                    </Td>
                  )}
                  {inWeek && <Td right>{fmt(r.implied_points, 1)}</Td>}
                  {inWeek && <Td right>{fmt(r.window_value, 2)}</Td>}
                  <Td right>{r.board_rank ?? '–'}</Td>
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

      {start && <RecentMoves moves={moves} league={league} start={start} />}
    </div>
  );
}
