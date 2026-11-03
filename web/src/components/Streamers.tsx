import { useCallback, useEffect, useMemo, useState } from 'react';

import { downloadCsv, toCsv } from '../lib/csv';
import { withRankTotal } from '../lib/streamer-rows';
import { fetchCurrentJson, fetchPageRows, getLatest, type League } from '../lib/data';
import { useWarmUp } from '../lib/warm';
import { blowout, nextGames } from '../lib/blowout';
import { CATEGORIES, CATEGORY_LABELS, day, fmt, lineSource, pct } from '../lib/format';
import { currentLeague, LEAGUE_LABEL } from '../lib/league';
import { eligibleAt, POSITION_LETTERS, type PositionLetter, sortRows, type SortDir, toggle } from '../lib/players';
import { type CrewFields, crewText } from '../lib/referees';
import { href } from '../lib/site';
import { useWatchlist } from '../lib/watchlist';
import { keptCategories, owners, useLeague } from '../lib/fantasy-league';
import { fantasyPoints } from '../lib/league-value';
import { BlowoutTag, Card, Chip, InjuryTag, injuryDetail, LineupTag, lineupDay, Loading, NewsTag, RestRiskTag, NewTeam, Note, Problem, Signed, SortTh, Star, TagLegend, Td, Th, TopOutTag, TrendTag } from './ui';
import type { StreamerColumn, ExportedRow } from '../generated/columns';

interface StreamerRowFields {
  player_id: string;
  /** Today's role from the league's starting lineups (NBA): starter, bench or inactive. */
  lineup_role?: string | null;
  lineup_confirmed?: boolean | null;
  /** How widely ESPN leagues roster the player: most, many, some, few or rare. */
  ownership_bucket?: string | null;
  /** The team has nothing left to play for in the last stretch (fct_team_stakes). */
  rest_risk?: boolean | null;
  /** Sleeper leagues that added and dropped the player over the last day (NBA; null when not trending). */
  sleeper_adds?: number | null;
  sleeper_drops?: number | null;
  /** adding or dropping across Sleeper leagues over the last day. */
  waiver_trend?: string | null;
  /** The team's largest-usage player, when the official report has them out for the next game (#485). */
  top_teammate_out?: string | null;
  top_teammate_out_usage?: number | null;
  /** rising or falling ESPN ownership (both leagues). */
  ownership_trend?: string | null;
  /** What the team still plays for (fct_team_stakes), behind the rest-risk tag. */
  team_stakes?: string | null;
  /** Team games left this fantasy week, Monday to Sunday. */
  games_this_week?: number | null;
  news_flag?: string | null;
  news_headline?: string | null;
  news_date?: string | null;
  lineup_date?: string | null;
  injury_type?: string | null;
  expected_return?: string | null;
  injury_note?: string | null;
  injury_news?: string | null;
  injury_since?: string | null;
  injury_source?: string | null;
  official_game_date?: string | null;
  official_report_at?: string | null;
  full_name: string | null;
  position: string | null;
  team_id: string | null;
  team_abbreviation: string | null;
  season: string;
  season_complete: boolean;
  games_next_7: number;
  last_game_date: string | null;
  games_season: number | null;
  minutes_avg_5: number | null;
  minutes_trend: number | null;
  minutes_baseline: number | null;
  season_z_total: number | null;
  last_10_z_total: number | null;
  last_10_points_pg: number | null;
  last_10_rebounds_total_pg: number | null;
  last_10_assists_pg: number | null;
  last_10_steals_pg: number | null;
  last_10_blocks_pg: number | null;
  last_10_three_pointers_made_pg: number | null;
  last_10_turnovers_pg: number | null;
  last_10_fga_pg: number | null;
  last_10_fta_pg: number | null;
  last_10_fgm_pg: number | null;
  last_10_ftm_pg: number | null;
  value_trend: number | null;
  rank_total: number | null;
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
  turnovers_avg_5: number | null;
  injury_status: string | null;
  injury_group: string | null;
  [key: string]: unknown;
}
// Only columns the export ships (export/layout.py): a field it does not ship fails the type check (#479).
type StreamerRow = ExportedRow<StreamerColumn, StreamerRowFields>;

interface Game extends CrewFields {
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
  /** Who posted the line and the day it was taken (#462). */
  line_provider?: string | null;
  line_as_of?: string | null;
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
  /** The referee crew's chief and tendency, once assigned. */
  crew: string | null;
}

function lineText(g: Game): string | null {
  if (typeof g.over_under !== 'number' || typeof g.home_spread !== 'number') return null;
  const favourite = g.home_spread <= 0 ? g.home_team_tricode : g.away_team_tricode;
  const spread = g.home_spread === 0 ? 'even' : `${favourite} -${Math.abs(g.home_spread)}`;
  const source = lineSource(g.line_provider, g.line_as_of);
  return `Over/under ${g.over_under}, ${spread}${source ? ` (${source})` : ''}`;
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
        Signings, waivers, trades{league === 'nba' ? ' and G League moves' : ''} of the last two weeks: a new role on a new team, or minutes opening up behind a player who left.
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

/** Games per team per fantasy week for the rest of the season (fct_team_week_games). */
interface TeamWeek {
  league: string;
  season: string;
  team_id: string;
  team_abbreviation: string | null;
  fantasy_week: string;
  week_start: string;
  week_end: string;
  is_current_week: boolean;
  games: number;
  games_left: number;
  games_if_necessary: number;
  game_dates: string | null;
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
  /** Sleeper leagues that added the player minus those that dropped the player, over the last day. */
  sleeper_net: number | null;
  /** Last-ten value over the league's categories: an 8-category league leaves out turnovers. */
  value_10: number | null;
  /** What an average game of the last ten adds to the week's category totals (8 categories: no turnovers). */
  production_10: number | null;
}

/** A count of Sleeper leagues, short: 26,552 as 26.6k. */
function leagues(n: number): string {
  const a = Math.abs(n);
  return a >= 1000 ? `${(a / 1000).toFixed(1)}k` : String(a);
}

/** Net adds across Sleeper leagues over the last day, coloured by direction, with both counts in the tooltip. */
function WaiverHeat({ row }: { row: Candidate }) {
  if (row.sleeper_net === null) return <span className="text-muted">–</span>;
  const n = row.sleeper_net;
  const cls = n > 0 ? 'text-good' : n < 0 ? 'text-bad' : '';
  const title = `${(row.sleeper_adds ?? 0).toLocaleString()} Sleeper leagues added the player and ${(row.sleeper_drops ?? 0).toLocaleString()} dropped the player in the last day`;
  return (
    <span className={cls} title={title} data-testid="waiver-heat">
      {n > 0 ? '+' : n < 0 ? '−' : ''}
      {leagues(n)}
    </span>
  );
}

type Health = 'all' | 'no_out' | 'healthy';

const PAGE = 50;
/** Rows in the first paint, before the browser is idle (#562). */
const FIRST_ROWS = 10;
const HORIZONS = [3, 7, 14];
// A league-sized pool on the board (teams x roster spots); players inside it are most likely rostered.
const ROSTERED = { nba: [0, 100, 156, 200], wnba: [0, 60, 100, 140] } as const;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Built once, as in lib/format.ts (#557).
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const DAY_LABEL = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

function weekday(iso: string): string {
  return WEEKDAY.format(new Date(`${iso}T00:00:00Z`));
}

/** "Mon, Nov 9". */
function dayLabel(iso: string): string {
  return DAY_LABEL.format(new Date(`${iso}T00:00:00Z`));
}

/** A period of the manager's own (#523): any start and end day, kept in the URL (?from=&to=) so it can be shared. */
interface Period {
  from: string;
  to: string;
}
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_MAX_DAYS = 31;

function periodFromUrl(): Period | null {
  if (typeof window === 'undefined') return null;
  const q = new URL(window.location.href).searchParams;
  const from = q.get('from');
  const to = q.get('to');
  return from && to && ISO_DAY.test(from) && ISO_DAY.test(to) && from <= to ? { from, to } : null;
}

function writePeriod(p: Period | null): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (p) {
    url.searchParams.set('from', p.from);
    url.searchParams.set('to', p.to);
  } else {
    url.searchParams.delete('from');
    url.searchParams.delete('to');
  }
  window.history.replaceState(null, '', url);
}

/** The days from one day to another, both included, at most PERIOD_MAX_DAYS. */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < PERIOD_MAX_DAYS; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Next week's Monday: the Monday after the fantasy week the day falls in. */
function nextMonday(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return addDays(iso, d === 0 ? 1 : 8 - d);
}

function WeekGrid({ games, teams, days, picked }: { games: Game[]; teams: string[]; days: string[]; picked: Set<string> }) {
  const inRange = new Set(days);
  const byTeamDay = new Map<string, GridCell>();
  const perDay = new Map<string, number>();
  for (const g of games) {
    if (!inRange.has(g.game_date)) continue;
    const line = lineText(g);
    const altitude = !!g.at_altitude;
    const crew = crewText(g);
    byTeamDay.set(`${g.home_team_tricode}|${g.game_date}`, {
      label: `v ${g.away_team_tricode}`,
      implied: g.home_implied_points ?? null,
      line,
      backToBack: !!g.home_back_to_back,
      // the home team plays at its own altitude every other night: only the visitor is marked
      altitude: false,
      miles: null,
      crew,
    });
    byTeamDay.set(`${g.away_team_tricode}|${g.game_date}`, {
      label: `@ ${g.home_team_tricode}`,
      implied: g.away_implied_points ?? null,
      line,
      backToBack: !!g.away_back_to_back,
      altitude,
      miles: g.away_miles_travelled ?? null,
      crew,
    });
    perDay.set(g.game_date, (perDay.get(g.game_date) ?? 0) + 2);
  }
  const counts = new Map(teams.map((t) => [t, days.filter((d) => byTeamDay.has(`${t}|${d}`)).length]));
  const ordered = [...teams].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
  const busiest = Math.max(0, ...days.map((d) => perDay.get(d) ?? 0));
  return (
    <div className="table-scroll max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="Games by day">
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
                            cell.altitude ? 'Visiting at altitude (4,000 ft or more)' : null,
                            cell.crew,
                          ]
                            .filter(Boolean)
                            .join('. ') || undefined
                        : undefined
                    }
                  >
                    {cell?.label ?? '·'}
                    {cell?.backToBack && (
                      <span className="ml-1 rounded border border-bad bg-card px-0.5 text-[11px] font-semibold text-bad" data-testid="back-to-back">
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

/** Games per team per fantasy week, this week to the last scheduled game: busiest teams first. */
function WeeksGrid({ weeks }: { weeks: TeamWeek[] }) {
  const columns = [...new Map(weeks.map((w) => [w.fantasy_week, w])).values()].sort((a, b) => a.week_start.localeCompare(b.week_start));
  const label = (w: TeamWeek) => w.team_abbreviation ?? w.team_id;
  const teams = [...new Set(weeks.map(label))];
  const cell = new Map(weeks.map((w) => [`${label(w)}|${w.fantasy_week}`, w]));
  // In the current week only the games still to come count: a manager picking up today reads what is left.
  const remaining = (w: TeamWeek | undefined) => (w ? (w.is_current_week ? w.games_left : w.games) : 0);
  const total = new Map(teams.map((t) => [t, columns.reduce((n, c) => n + remaining(cell.get(`${t}|${c.fantasy_week}`)), 0)]));
  const ordered = [...teams].sort((a, b) => (total.get(b) ?? 0) - (total.get(a) ?? 0) || a.localeCompare(b));
  return (
    <div className="table-scroll max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="Games per fantasy week">
      <table className="w-full text-sm" data-testid="weeks-grid">
        <thead>
          <tr>
            <Th>Team</Th>
            <Th right>Games</Th>
            {columns.map((c) => (
              <th
                key={c.fantasy_week}
                scope="col"
                className={`px-2 py-1.5 text-center text-xs font-medium whitespace-nowrap ${c.is_current_week ? 'text-accent' : 'text-muted'}`}
                title={`${c.week_start} to ${c.week_end}`}
              >
                W{c.fantasy_week.slice(-2)}
                <div>{c.week_start.slice(5).replace('-', '/')}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordered.map((t) => (
            <tr key={t} className="border-t border-line">
              <Td>{t}</Td>
              <Td right>{total.get(t) ?? 0}</Td>
              {columns.map((c) => {
                const w = cell.get(`${t}|${c.fantasy_week}`);
                const n = remaining(w);
                const tone = n >= 4 ? 'font-semibold text-good' : n <= 2 ? 'text-muted' : '';
                const title =
                  w && c.is_current_week
                    ? `${w.games_left} of ${w.games} left this week${w.game_dates ? ` (${w.game_dates})` : ''}`
                    : (w?.game_dates ?? undefined);
                return (
                  <td
                    key={c.fantasy_week}
                    className={`px-2 py-1.5 text-center tabular-nums ${tone}`}
                    title={title}
                    data-testid={c.is_current_week ? 'week-left' : undefined}
                  >
                    {n}
                    {w && c.is_current_week ? <span className="text-xs text-muted"> of {w.games}</span> : null}
                    {w && w.games_if_necessary > 0 ? <span className="text-xs text-muted"> +{w.games_if_necessary}</span> : null}
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

/** A numeric column of a streamer row, or 0. */
function part(r: StreamerRow, key: string): number {
  const v = r[key];
  return typeof v === 'number' && !Number.isNaN(v) ? v : 0;
}

export default function Streamers() {
  const [league] = useState<League>(() => currentLeague());
  const [rows, setRows] = useState<StreamerRow[] | null>(null);
  const [games, setGames] = useState<Game[]>([]);
  // The schedule file failed to load: the page must not read that as "no games ahead" (#440).
  const [scheduleError, setScheduleError] = useState<unknown>(null);
  const [moves, setMoves] = useState<Move[]>([]);
  const [teams, setTeams] = useState<string[]>([]);
  const [weeks, setWeeks] = useState<TeamWeek[]>([]);
  const [start, setStart] = useState<string>(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<unknown>(null);
  const [horizonChoice, setHorizonChoice] = useState<number | 'week'>(7);
  const [period, setPeriod] = useState<Period | null>(() => periodFromUrl());
  // Days from the grid's first day to the end of the fantasy week (Sunday).
  const weekDays = useMemo(() => {
    const d = new Date(`${start}T12:00:00Z`).getUTCDay();
    return d === 0 ? 1 : 8 - d;
  }, [start]);
  const horizon = horizonChoice === 'week' ? weekDays : horizonChoice;
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
  const [addingOnly, setAddingOnly] = useState(false);
  // Sorted by window value while games are scheduled (the streamer signals notebook found it the
  // best guide to the week's pickups), else by the minutes trend; a header click overrides.
  const [sortChoice, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [shown, setShown] = useState(PAGE);
  // The note and the first rows paint first; the rest of the page of rows when the browser is idle (#562).
  const warm = useWarmUp(!!rows);
  const { watched, toggleWatched } = useWatchlist(league);
  // With the league's rosters in, leave out exactly the players on them (-1); otherwise a board-rank cut.
  const [setup] = useLeague(league);
  const owner = useMemo(() => owners(setup), [setup]);
  const rostered = rosteredChoice ?? (owner.size ? -1 : 0);

  useEffect(() => {
    let live = true;
    Promise.all([
      fetchPageRows<StreamerRow>(`streamers/${league}`),
      fetchCurrentJson<Game[]>(`schedule/${league}.json`).catch((e: unknown) => {
        if (live) setScheduleError(e);
        return [] as Game[];
      }),
      fetchCurrentJson<Team[]>('dim_team.json'),
      getLatest(),
      // Older builds have no transactions or team-weeks file.
      fetchCurrentJson<Move[]>(`transactions/${league}.json`).catch(() => [] as Move[]),
      fetchCurrentJson<TeamWeek[]>(`team_weeks/${league}.json`).catch(() => [] as TeamWeek[]),
    ])
      .then(([s, g, t, latest, mv, tw]) => {
        if (!live) return;
        setRows(withRankTotal(s));
        setGames(g);
        setMoves(mv);
        setWeeks(tw);
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

  // Each team's next game, for the blowout flag on its starters (#486).
  const nextByTeam = useMemo(() => nextGames(games), [games]);
  const sortKey = sortChoice ?? (games.some((g) => g.days_ahead <= 6) ? 'window_value' : 'minutes_trend');
  const days = useMemo(
    () => (period ? daysBetween(period.from, period.to) : Array.from({ length: horizon }, (_, i) => addDays(start, i))),
    [start, horizon, period],
  );
  const lastScheduled = useMemo(() => games.reduce((m, g) => (g.game_date > m ? g.game_date : m), ''), [games]);
  const pickPeriod = (p: Period | null) => {
    const next = p && ISO_DAY.test(p.from) && ISO_DAY.test(p.to) ? { from: p.from, to: p.to < p.from ? p.from : p.to } : null;
    setPeriod(next);
    writePeriod(next);
    setPickedDays(new Set());
  };
  const periodTitle = period ? `Games from ${dayLabel(period.from)} to ${dayLabel(period.to)}` : null;
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

  // A points league scores the last-ten per-game line with its own weights (#467).
  const points = setup.scoring === 'points';
  const weights = setup.weights;
  const last10Points = useCallback(
    (r: StreamerRow): number | null => {
      if (r.last_10_points_pg === null || r.last_10_points_pg === undefined) return null;
      return fantasyPoints(
        {
          proj_points_pg: r.last_10_points_pg,
          proj_rebounds_total_pg: r.last_10_rebounds_total_pg,
          proj_assists_pg: r.last_10_assists_pg,
          proj_steals_pg: r.last_10_steals_pg,
          proj_blocks_pg: r.last_10_blocks_pg,
          proj_three_pointers_made_pg: r.last_10_three_pointers_made_pg,
          proj_turnovers_pg: r.last_10_turnovers_pg,
          proj_fgm_pg: r.last_10_fgm_pg,
          proj_fga_pg: r.last_10_fga_pg,
          proj_ftm_pg: r.last_10_ftm_pg,
          proj_fta_pg: r.last_10_fta_pg,
        },
        weights,
      );
    },
    [weights],
  );
  // The categories the league does not count: its punts (#661), and turnovers in an 8-category
  // league. Their parts come out of the last-ten value and production (#666).
  const dropped = useMemo(() => {
    const kept = keptCategories(setup);
    return points ? [] : CATEGORIES.filter((c) => !kept.includes(c));
  }, [setup, points]);
  const value10 = useCallback(
    (r: StreamerRow): number | null => {
      if (points) return last10Points(r);
      if (r.last_10_z_total === null) return null;
      return dropped.reduce((s, c) => s - part(r, `last_10_${c}`), r.last_10_z_total);
    },
    [dropped, points, last10Points],
  );
  const production10 = useCallback(
    (r: StreamerRow): number | null => {
      if (points) return last10Points(r);
      const p = r.last_10_production as number | null | undefined;
      if (typeof p !== 'number') return null;
      return dropped.reduce((s, c) => s - part(r, `last_10_production_${c.slice(2)}`), p);
    },
    [dropped, points, last10Points],
  );
  // The manager's league pool (teams x roster spots), as a likely-available cut.
  const leaguePool = setup.teams * setup.rosterSpots;
  const rosteredCuts = useMemo(
    () => [...new Set<number>([0, ...ROSTERED[league], leaguePool])].sort((a, b) => a - b),
    [league, leaguePool],
  );

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
          value_10: value10(r),
          production_10: production10(r),
          // a points league's window is fantasy points times games; the matchup is in category units and stays out
          window_value: production10(r) === null || !dates.size ? null : (production10(r) ?? 0) * dates.size + (points ? 0 : muSum),
          sleeper_net: r.waiver_trend ? (r.sleeper_adds ?? 0) - (r.sleeper_drops ?? 0) : null,
        };
      }),
    [rows, teamDates, teamMatchups, teamImplied, pickedDays, needs, value10, production10, points],
  );

  const hasHeat = (rows ?? []).some((r) => r.waiver_trend);

  const list = useMemo(() => {
    const filtered = candidates
      .filter((r) => eligibleAt(r.position, positions))
      .filter((r) => !team || r.team_abbreviation === team)
      .filter((r) => r.games_window >= minGames)
      .filter((r) => (r.minutes_avg_5 ?? 0) >= minMinutes)
      .filter((r) => health === 'all' || (health === 'no_out' ? r.injury_group !== 'out' : !r.injury_group || r.injury_group === 'probable'))
      .filter((r) =>
        rostered === -1
          ? !owner.has(r.player_id)
          : rostered === -2
            ? !['most', 'many', 'some'].includes(r.ownership_bucket ?? '')
            : !rostered || r.rank_total === null || r.rank_total > rostered,
      )
      .filter((r) => pickedDays.size === 0 || r.games_picked > 0)
      .filter((r) => !watchOnly || watched.has(r.player_id))
      .filter((r) => !startersOnly || r.lineup_role === 'starter')
      .filter((r) => !addingOnly || (hasHeat ? r.waiver_trend === 'adding' : r.ownership_trend === 'rising'));
    return sortRows(filtered, (r) => {
      if (sortKey === 'name') return r.full_name;
      const v = r[sortKey];
      return typeof v === 'number' ? v : null;
    }, sortDir);
  }, [candidates, positions, team, minGames, minMinutes, health, rostered, owner, pickedDays, watchOnly, watched, startersOnly, addingOnly, hasHeat, sortKey, sortDir]);

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
  const hasTrend = (rows ?? []).some((r) => r.ownership_trend);
  const exportCsv = () => {
    const header = ['player', 'team', 'new_team_from', 'position', period ? `games_${period.from}_to_${period.to}` : `games_next_${horizon}`, 'matchup', 'implied_team_points', 'window_value', 'games_on_picked_days', 'games_played', 'minutes_last_5', 'minutes_baseline', 'minutes_trend', 'value_last_10', 'value_trend', 'need_fit', 'sleeper_net_adds', 'espn_trend', 'board_rank', 'points', 'rebounds', 'assists', 'steals', 'blocks', 'threes', 'fg_pct', 'ft_pct', 'turnovers', 'injury', 'lineup', 'news', 'last_game'];
    const body = list.map((r) => [r.full_name, r.team_abbreviation, r.is_new_team ? r.prev_team_abbreviation : null, r.position, r.games_window, r.matchup, r.implied_points, r.window_value, r.games_picked, r.games_season, r.minutes_avg_5, r.minutes_baseline, r.minutes_trend, r.value_10, r.value_trend, r.fit, r.sleeper_net, r.ownership_trend, r.rank_total, r.points_avg_5, r.rebounds_total_avg_5, r.assists_avg_5, r.steals_avg_5, r.blocks_avg_5, r.three_pointers_made_avg_5, r.field_goal_pct_5, r.free_throw_pct_5, r.turnovers_avg_5, r.injury_status, r.lineup_role, r.news_flag, r.last_game_date]);
    downloadCsv(`fantasyscout-${league}-streamers.csv`, toCsv(header, body));
  };
  const select = 'rounded border border-line bg-card px-2 py-1';

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      {scheduleError ? (
        <div className="rounded-lg border border-line bg-card p-4" role="alert" data-testid="schedule-unavailable">
          <p className="font-medium">The {LEAGUE_LABEL[league]} schedule could not be loaded.</p>
          <p className="mt-1 text-sm text-muted">
            Games ahead, matchups and the window value need it; the list below is sorted by minutes trend until it loads.
            Reload in a moment.
          </p>
          <button type="button" className="mt-2 rounded border border-line px-3 py-1 text-sm" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      ) : complete || !inWeek ? (
        <Note testid="season-note">
          No {LEAGUE_LABEL[league]} regular-season games in the next seven days. The list below is who finished the {season} season strongly: their last five
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
        <Card title={periodTitle ?? (horizonChoice === 'week' ? 'Games left this fantasy week' : `Games in the next ${horizon} days`)} id="schedule">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Window">
              {[...HORIZONS, 'week' as const].map((h) => (
                <button
                  key={h}
                  type="button"
                  role="radio"
                  aria-checked={!period && horizonChoice === h}
                  onClick={() => {
                    setHorizonChoice(h);
                    pickPeriod(null);
                  }}
                  title={h === 'week' ? 'The rest of the fantasy week, to Sunday' : undefined}
                  className={`rounded-full border px-3 py-1 text-sm ${!period && horizonChoice === h ? 'border-accent bg-accent text-accent-fg' : 'border-line'}`}
                >
                  {h === 'week' ? `This week (${weekDays} ${weekDays === 1 ? 'day' : 'days'})` : `${h} days`}
                </button>
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={!!period}
                onClick={() => pickPeriod(period ?? { from: nextMonday(start), to: addDays(nextMonday(start), 6) })}
                title="Any start and end day: next week, say, or Monday to Friday"
                className={`rounded-full border px-3 py-1 text-sm ${period ? 'border-accent bg-accent text-accent-fg' : 'border-line'}`}
              >
                Custom
              </button>
            </div>
            {period && (
              <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="period">
                <label className="flex items-center gap-1">
                  <span className="text-muted">From</span>
                  <input
                    type="date"
                    value={period.from}
                    min={start || undefined}
                    max={lastScheduled || undefined}
                    onChange={(e) => pickPeriod({ from: e.target.value, to: period.to })}
                    aria-label="Period start"
                    className="rounded border border-line bg-bg px-2 py-1"
                  />
                </label>
                <label className="flex items-center gap-1">
                  <span className="text-muted">To</span>
                  <input
                    type="date"
                    value={period.to}
                    min={period.from}
                    max={lastScheduled || undefined}
                    onChange={(e) => pickPeriod({ from: period.from, to: e.target.value })}
                    aria-label="Period end"
                    className="rounded border border-line bg-bg px-2 py-1"
                  />
                </label>
                <button type="button" onClick={() => pickPeriod({ from: nextMonday(start), to: addDays(nextMonday(start), 6) })} className="rounded border border-line px-2 py-1 text-xs hover:bg-bg">
                  Next week
                </button>
                <button type="button" onClick={() => pickPeriod({ from: nextMonday(start), to: addDays(nextMonday(start), 4) })} className="rounded border border-line px-2 py-1 text-xs hover:bg-bg">
                  Next week, Mon to Fri
                </button>
                {lastScheduled && period.to > lastScheduled && (
                  <span className="text-xs text-muted" data-testid="period-note">
                    The schedule is published through {dayLabel(lastScheduled)}; later days show no games yet.
                  </span>
                )}
              </div>
            )}
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

      {/* Nothing is left to stream once the season is over (#450). */}
      {weeks.length > 0 && !complete && (
        <Card title="Games per fantasy week, rest of season" id="weeks">
          <p className="mb-3 text-sm text-muted">
            Monday-to-Sunday weeks from this one to the last scheduled game, regular season and playoffs. A team with four games
            is worth a streaming spot that week; two is a week to look elsewhere. &ldquo;+1&rdquo; is an if-necessary playoff game.
          </p>
          <WeeksGrid weeks={weeks} />
        </Card>
      )}

      <Card title={scheduleError ? 'Trending up' : complete || !inWeek ? 'Finished strong' : 'Best pickups this window'} id="trending">
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
                {rosteredCuts.map((n) => (
                  <option key={n} value={n}>
                    {n ? `outside the top ${n}${n === leaguePool ? ` (your league: ${setup.teams} × ${setup.rosterSpots})` : ''}` : 'everyone'}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={watchOnly} onChange={(e) => setWatchOnly(e.target.checked)} />
              Watchlist only ({watched.size})
            </label>
            {rows.some((r) => r.lineup_role) && (
              <label className="flex items-center gap-2 text-sm" title="From the league's starting lineups for the next game day (NBA)">
                <input type="checkbox" checked={startersOnly} onChange={(e) => setStartersOnly(e.target.checked)} />
                <span data-testid="starters-label">Starting {lineupDay(rows.find((r) => r.lineup_date)?.lineup_date)}</span>
              </label>
            )}
            {(hasHeat || hasTrend) && (
              <label
                className="flex items-center gap-2 text-sm"
                title={hasHeat ? 'Players more Sleeper leagues added than dropped in the last day' : 'Players rising in ESPN leagues: rostered in a point or more of them than before'}
              >
                <input type="checkbox" checked={addingOnly} onChange={(e) => setAddingOnly(e.target.checked)} />
                {hasHeat ? 'Being added on Sleeper' : 'Rising in ESPN leagues'}
              </label>
            )}
            <span className="text-sm text-muted">{list.length} players</span>
            <button type="button" onClick={exportCsv} className="rounded border border-line px-3 py-1 text-sm hover:bg-card" data-testid="streamers-csv">
              Export CSV
            </button>
          </div>
        </div>
        <TagLegend />
        <div className="table-scroll max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="Streamer candidates">
          <table className="w-full text-sm" data-testid="trending">
            <thead>
              <tr>
                <SortTh active={sortKey === 'name'} dir={sortDir} onClick={() => sortBy('name', 'asc')} pin="first" title="The player, with injury, lineup and news tags">
                  Player
                </SortTh>
                {inWeek && col('window_value', 'Window value', 'What the player adds to the window: last-ten production per game (counting stats and shooting above the pool, turnovers subtracted) times games in the window, plus each game’s matchup. The default sort: it finds the week’s best pickups most often (streamer signals notebook)')}
                {inWeek && col('games_window', period ? 'Period' : `Next ${horizon}`, period ? `Team games from ${dayLabel(period.from)} to ${dayLabel(period.to)}` : `Team games in the next ${horizon} days`)}
                {inWeek && col('matchup', 'Matchup', 'Average value per game the opponents add or take away in this window: their defence and the expected pace (small: about 0.2 for one standard deviation of defence)')}
                {inWeek && col('implied_points', 'Team pts', 'Points the betting lines imply the team scores, per game in the window that has a line: a high-scoring game means more counting stats')}
                <Th>
                  <span title="The player's team, with the team the player left when the move is recent">Team</span>
                </Th>
                <Th>
                  <span title="The positions the player is listed at">Pos</span>
                </Th>
                {col('games_season', 'GP', 'Games played this season: a short sample makes the trends below less sure (#463)')}
                {col('minutes_avg_5', 'Min (5)', 'Minutes per game, last five games')}
                {col('minutes_baseline', 'Min (base)', 'Minutes per game before the last five games, blended with last season')}
                {col('minutes_trend', 'Min trend', 'Last five games minus the baseline')}
                {col(
                  'value_10',
                  points ? 'FPts (10)' : 'Value (10)',
                  points
                    ? "Fantasy points per game over the last ten games, scored with your league's weights"
                    : dropped.length
                      ? `Total category z-score over the last ten games, leaving out ${dropped.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}`
                      : 'Total category z-score over the last ten games',
                )}
                {col('value_trend', 'Value trend', 'Last-ten value minus the baseline (this season blended with last)')}
                {/* The box-score columns are the last five games, like Min (5) (#456). */}
                {col('points_avg_5', 'PTS (5)', 'Points per game, last five games')}
                {col('rebounds_total_avg_5', 'REB (5)', 'Rebounds per game, last five games')}
                {col('assists_avg_5', 'AST (5)', 'Assists per game, last five games')}
                {col('steals_avg_5', 'STL (5)', 'Steals per game, last five games')}
                {col('blocks_avg_5', 'BLK (5)', 'Blocks per game, last five games')}
                {col('three_pointers_made_avg_5', '3PM (5)', 'Three-pointers made per game, last five games')}
                {col('field_goal_pct_5', 'FG% (5)', 'Field-goal percentage over the last five games')}
                {col('free_throw_pct_5', 'FT% (5)', 'Free-throw percentage over the last five games')}
                {col('turnovers_avg_5', 'TO (5)', 'Turnovers per game, last five games')}
                {needs.size > 0 && col('fit', 'Need fit', 'Last-ten z-score summed over the categories you need')}
                {pickedDays.size > 0 && col('games_picked', 'Open days', 'Games on the days you have open')}
                {hasTrend && (
                  <Th right>
                    <span title="Rising or falling across ESPN leagues (ownership up or down a point or more)">ESPN</span>
                  </Th>
                )}
                {hasHeat && col('sleeper_net', 'Sleeper', 'Sleeper leagues that added the player minus those that dropped the player, last 24 hours (from Sleeper)')}
                {col('rank_total', 'Board #', 'Rank on the board with the default league settings (12 teams of 13 in the NBA, 10 of 10 in the WNBA); inside a league-sized pool usually means rostered')}
                <Th>
                  <span title="The date of the player's most recent game">Last game</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, warm ? shown : Math.min(shown, FIRST_ROWS)).map((r) => (
                <tr key={r.player_id} className="border-t border-line">
                  <td className="pin max-w-[11rem] px-2 py-1.5 sm:max-w-none">
                    <span className="flex flex-wrap items-center gap-1 sm:flex-nowrap">
                      <Star on={watched.has(r.player_id)} label={r.full_name ?? r.player_id} onToggle={() => toggleWatched(r.player_id)} />
                      <a href={href(`/p/${league}/${r.player_id}/`)} className="whitespace-nowrap underline-offset-4 hover:underline">
                        {r.full_name ?? r.player_id}
                      </a>
                      {r.is_new_team && <NewTeam from={r.prev_team_abbreviation} />}
                      <LineupTag role={r.lineup_role} confirmed={r.lineup_confirmed} date={r.lineup_date} injuryGroup={r.injury_group} />
                      <RestRiskTag risk={r.rest_risk} stakes={r.team_stakes} />
                      <BlowoutTag risk={blowout(league, r.lineup_role, r.team_id ? nextByTeam.get(r.team_id) : undefined)} />
                      <TopOutTag name={r.top_teammate_out} usage={r.top_teammate_out_usage} />
                      <NewsTag flag={r.news_flag} headline={r.news_headline} date={r.news_date} />
                      <InjuryTag group={r.injury_group} status={r.injury_status} detail={injuryDetail(r)} />
                    </span>
                  </td>
                  {inWeek && <Td right>{fmt(r.window_value, 2)}</Td>}
                  {inWeek && <Td right>{r.games_window}</Td>}
                  {inWeek && (
                    <Td right>
                      <Signed value={r.matchup} />
                    </Td>
                  )}
                  {inWeek && <Td right>{fmt(r.implied_points, 1)}</Td>}
                  <Td>{r.team_abbreviation ?? '–'}</Td>
                  <Td>{r.position ?? '–'}</Td>
                  <Td right>{r.games_season ?? '–'}</Td>
                  <Td right>{fmt(r.minutes_avg_5)}</Td>
                  <Td right>{fmt(r.minutes_baseline)}</Td>
                  <Td right>
                    <Signed value={r.minutes_trend} digits={1} />
                  </Td>
                  <Td right>{fmt(r.value_10, 2)}</Td>
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
                  <Td right>{pct(r.free_throw_pct_5)}</Td>
                  <Td right>{fmt(r.turnovers_avg_5)}</Td>
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
                  {hasTrend && (
                    <Td right>
                      <TrendTag trend={r.ownership_trend} />
                    </Td>
                  )}
                  {hasHeat && (
                    <Td right>
                      <WaiverHeat row={r} />
                    </Td>
                  )}
                  <Td right>{r.rank_total ?? '–'}</Td>
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
        {points && (
          <p className="mt-2 text-xs text-muted" data-testid="points-note">
            Your league scores points: FPts (10) and the window value are fantasy points per game over the last ten games under your
            league&apos;s weights (the matchup adjustment is in category units and is left out).
          </p>
        )}
        {hasHeat && (
          <p className="mt-2 text-xs text-muted">
            Waiver heat from{' '}
            <a href="https://sleeper.com" className="underline underline-offset-4">
              Sleeper
            </a>
            : the players its leagues added and dropped most in the last day.
          </p>
        )}
      </Card>

      {start && <RecentMoves moves={moves} league={league} start={start} />}
    </div>
  );
}
