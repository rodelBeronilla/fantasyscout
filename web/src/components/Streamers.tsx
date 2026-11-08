import { useCallback, useEffect, useMemo, useState } from 'react';

import { downloadCsv, toCsv } from '../lib/csv';
import { withRankTotal } from '../lib/streamer-rows';
import { fetchCurrentJson, fetchPageRows, getLatest, type League } from '../lib/data';
import { useWarmUp } from '../lib/warm';
import { nextGames } from '../lib/blowout';
import { CATEGORIES, CATEGORY_LABELS } from '../lib/format';
import { currentLeague, LEAGUE_LABEL } from '../lib/league';
import { eligibleAt, POSITION_LETTERS, type PositionLetter, sortRows, type SortDir, toggle } from '../lib/players';
import { useWatchlist } from '../lib/watchlist';
import { assign, keptCategories, owners, useLeague } from '../lib/fantasy-league';
import { usePlayerNotes } from '../lib/player-notes';
import { fantasyPoints } from '../lib/league-value';
import { topAdds } from '../lib/pickups-top';
import { daysFromParam, needsFromParam, withNeeds } from '../lib/pickups-url';
import { readRaw, storageKey, writeRaw } from '../lib/storage';
import { type ReviewRow, teamReview, teamValues } from '../lib/team-review';
import { hasWeekGames } from '../lib/week-value';
import { addDays, dayLabel, type Game, type Move, RecentMoves, type TeamWeek, weekday, WeekGrid, WeeksGrid } from './PickupsSchedule';
import { type Candidate, PickupsTable, type StreamerRow } from './PickupsTable';
import { type ReviewState, TopAdds } from './TopAdds';
import { Chip, lineupDay, Loading, Note, Problem, Segmented, TagLegend, Unvalidated } from './ui';

interface Team {
  league: string;
  season: string;
  team_id: string;
  abbreviation: string;
}

type Health = 'all' | 'no_out' | 'healthy';

const PAGE = 50;
/** Rows in the first paint, before the browser is idle (#562). */
const FIRST_ROWS = 10;
const HORIZONS = [3, 7, 14];
// A league-sized pool on the board (teams x roster spots); players inside it are most likely rostered.
const ROSTERED = { nba: [0, 100, 156, 200], wnba: [0, 60, 100, 140] } as const;
/** Whether this viewer keeps "Explore all players" open (#819): closed until they open it. */
const EXPLORE_KEY = storageKey('pickups-explore');

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

/** A numeric column of a streamer row, or 0. */
function part(r: StreamerRow, key: string): number {
  const v = r[key];
  return typeof v === 'number' && !Number.isNaN(v) ? v : 0;
}

export default function Streamers() {
  // the box-score and identity columns, and which schedule grid shows (#722)
  const [moreCols, setMoreCols] = useState(false);
  const [scheduleView, setScheduleView] = useState<'window' | 'weeks'>('window');
  const [league] = useState<League>(() => currentLeague());
  const [rows, setRows] = useState<StreamerRow[] | null>(null);
  // each player's minutes before the last five games: whether a waiver opens a rotation spot (#722)
  const minutesOf = useMemo(() => new Map((rows ?? []).map((r) => [r.player_id, r.minutes_baseline ?? null])), [rows]);
  const [games, setGames] = useState<Game[]>([]);
  // The schedule file failed to load: the page must not read that as "no games ahead" (#440).
  const [scheduleError, setScheduleError] = useState<unknown>(null);
  const [moves, setMoves] = useState<Move[]>([]);
  const [teams, setTeams] = useState<string[]>([]);
  const [weeks, setWeeks] = useState<TeamWeek[]>([]);
  const [start, setStart] = useState<string>(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<unknown>(null);
  const [horizonChoice, setHorizonChoice] = useState<number | 'week'>(() => (new URLSearchParams(window.location.search).get('window') === 'week' ? 'week' : 7));
  const [period, setPeriod] = useState<Period | null>(() => periodFromUrl());
  // Days from the grid's first day to the end of the fantasy week (Sunday).
  const weekDays = useMemo(() => {
    const d = new Date(`${start}T12:00:00Z`).getUTCDay();
    return d === 0 ? 1 : 8 - d;
  }, [start]);
  const horizon = horizonChoice === 'week' ? weekDays : horizonChoice;
  // the lineup planner's link (#735): ?open=<days> picks the open days
  const [pickedDays, setPickedDays] = useState<Set<string>>(() => new Set(daysFromParam(new URLSearchParams(window.location.search).get('open'))));
  // the matchup's link (#818): ?need=<categories> preselects the need chips, close and losing ones first
  const [needs, setNeeds] = useState<Set<string>>(() => new Set(needsFromParam(new URLSearchParams(window.location.search).get('need'))));
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
  // best guide to the week's pickups), else by the minutes trend; a header click overrides. Needs
  // picked from the URL sort by the fit in them, as picking them here does.
  const [sortChoice, setSortKey] = useState<string | null>(() => (needs.size ? 'fit' : null));
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [shown, setShown] = useState(PAGE);
  const [exploreOpen, setExploreOpen] = useState(() => readRaw(EXPLORE_KEY) === 'open');
  // The note and the first rows paint first; the rest of the page of rows when the browser is idle (#562).
  const warm = useWarmUp(!!rows);
  const { watched, toggleWatched } = useWatchlist(league);
  // With the league's rosters in, leave out exactly the players on them (-1); otherwise a board-rank cut.
  const [setup, updateLeague] = useLeague(league);
  // a one-line note under a flagged top add, when the day's notes are out (#823)
  const notes = usePlayerNotes(league);
  const owner = useMemo(() => owners(setup), [setup]);
  const rostered = rosteredChoice ?? (owner.size ? -1 : 0);
  const hasRosters = owner.size > 0;

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

  // The board's rows behind the roster review (#819): who to drop for each top add, the player My
  // Team's moves would let go. Read only once the league's rosters are in.
  const [boardRows, setBoardRows] = useState<ReviewRow[] | null>(null);
  const [boardFailed, setBoardFailed] = useState(false);
  useEffect(() => {
    if (!hasRosters) return;
    let live = true;
    fetchPageRows<ReviewRow>(`board/${league}`)
      .then((b) => live && setBoardRows(b))
      .catch(() => live && setBoardFailed(true));
    return () => {
      live = false;
    };
  }, [league, hasRosters]);
  const values = useMemo(
    () =>
      boardRows
        ? teamValues(boardRows, { scoring: setup.scoring, punts: setup.punts, weights: setup.weights, teams: setup.teams, rosterSpots: setup.rosterSpots })
        : null,
    [boardRows, setup.scoring, setup.punts, setup.weights, setup.teams, setup.rosterSpots],
  );
  // the week unit when My Team opens on it: a head-to-head league with games left this week
  const reviewed = useMemo(
    () => (boardRows && values ? teamReview(league, boardRows, setup, values, setup.format === 'h2h' && hasWeekGames(boardRows)) : null),
    [league, boardRows, values, setup],
  );
  const boardById = useMemo(() => new Map((boardRows ?? []).map((r) => [r.player_id, r])), [boardRows]);

  // Each team's next game, for the blowout flag on its starters (#486).
  const nextByTeam = useMemo(() => nextGames(games), [games]);
  const sortKey = sortChoice ?? (games.some((g) => g.days_ahead <= 6) ? 'window_value' : 'minutes_trend');
  const days = useMemo(
    () => (period ? daysBetween(period.from, period.to) : Array.from({ length: horizon }, (_, i) => addDays(start, i))),
    [start, horizon, period],
  );
  // only the picked days inside the window count: a link's day the window does not hold (the
  // lineup planner's clock running ahead of the build) must not filter every row out (#735)
  const activePicked = useMemo(() => new Set([...pickedDays].filter((d) => days.includes(d))), [pickedDays, days]);
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
  const kept = useMemo(() => keptCategories(setup), [setup]);
  const dropped = useMemo(() => (points ? [] : CATEGORIES.filter((c) => !kept.includes(c))), [kept, points]);
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
          games_picked: [...activePicked].filter((d) => dates.has(d)).length,
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
    [rows, teamDates, teamMatchups, teamImplied, activePicked, needs, value10, production10, points],
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
      .filter((r) => activePicked.size === 0 || r.games_picked > 0)
      .filter((r) => !watchOnly || watched.has(r.player_id))
      .filter((r) => !startersOnly || r.lineup_role === 'starter')
      .filter((r) => !addingOnly || (hasHeat ? r.waiver_trend === 'adding' : r.ownership_trend === 'rising'));
    return sortRows(filtered, (r) => {
      if (sortKey === 'name') return r.full_name;
      const v = r[sortKey];
      return typeof v === 'number' ? v : null;
    }, sortDir);
  }, [candidates, positions, team, minGames, minMinutes, health, rostered, owner, activePicked, watchOnly, watched, startersOnly, addingOnly, hasHeat, sortKey, sortDir]);

  // The top adds (#819): the window's ranking over the players free in the league (with no rosters,
  // outside a league-sized pool on the board), each with the drop the roster review names.
  // only the manager's own roster entered: the rest of the league is unknown, so the board-rank cut stays
  const rivalsIn = setup.rosters.some((r, t) => t !== setup.mine && r.length > 0);
  const adds = useMemo(() => {
    const positionOf = new Map(candidates.map((r) => [r.player_id, r.position]));
    const outsidePool = (r: Candidate) => r.rank_total === null || r.rank_total > leaguePool;
    return topAdds({
      rows: candidates,
      available: (r) => !owner.has(r.player_id) && (rivalsIn || outsidePool(r)),
      needs: [...needs],
      kept,
      openDays: activePicked.size,
      drops: reviewed?.drops ?? [],
      roster: reviewed?.mine ?? [],
      position: (id) => boardById.get(id)?.position ?? positionOf.get(id),
    });
  }, [candidates, rivalsIn, owner, leaguePool, needs, kept, activePicked, reviewed, boardById]);

  if (error) return <Problem error={error} />;
  if (!rows) return <Loading what="streamers" />;

  const season = rows[0]?.season ?? '';
  const complete = rows.length > 0 && rows.every((r) => r.season_complete);
  // the page leads with the top adds while the window has games; else the list is the answer
  const leads = !scheduleError && inWeek && !complete;
  const teamOptions = [...new Set(rows.map((r) => r.team_abbreviation).filter((t): t is string => !!t))].sort();
  const sortBy = (key: string, dir: SortDir = 'desc') => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      setSortDir(dir);
    }
  };
  const toggleNeed = (c: string) => {
    const next = toggle(needs, c);
    setNeeds(next);
    // kept in the address, so the chips survive a reload and a shared link
    window.history.replaceState(null, '', withNeeds(window.location.href, CATEGORIES.filter((k) => next.has(k))));
    if (next.size) {
      setSortKey('fit');
      setSortDir('desc');
    } else if (sortKey === 'fit') setSortKey('minutes_trend');
  };
  const rememberExplore = (open: boolean) => {
    setExploreOpen(open);
    writeRaw(EXPLORE_KEY, open ? 'open' : 'closed');
  };
  const openExplore = () => {
    rememberExplore(true);
    window.requestAnimationFrame(() => document.getElementById('trending')?.scrollIntoView({ block: 'start' }));
  };
  const hasTrend = (rows ?? []).some((r) => r.ownership_trend);
  const exportCsv = () => {
    const header = ['player', 'team', 'new_team_from', 'position', period ? `games_${period.from}_to_${period.to}` : `games_next_${horizon}`, 'matchup', 'implied_team_points', 'window_value', 'games_on_picked_days', 'games_played', 'minutes_last_5', 'minutes_baseline', 'minutes_trend', 'value_last_10', 'value_trend', 'need_fit', 'sleeper_net_adds', 'espn_trend', 'board_rank', 'points', 'rebounds', 'assists', 'steals', 'blocks', 'threes', 'fg_pct', 'ft_pct', 'turnovers', 'injury', 'lineup', 'news', 'last_game'];
    const body = list.map((r) => [r.full_name, r.team_abbreviation, r.is_new_team ? r.prev_team_abbreviation : null, r.position, r.games_window, r.matchup, r.implied_points, r.window_value, r.games_picked, r.games_season, r.minutes_avg_5, r.minutes_baseline, r.minutes_trend, r.value_10, r.value_trend, r.fit, r.sleeper_net, r.ownership_trend, r.rank_total, r.points_avg_5, r.rebounds_total_avg_5, r.assists_avg_5, r.steals_avg_5, r.blocks_avg_5, r.three_pointers_made_avg_5, r.field_goal_pct_5, r.free_throw_pct_5, r.turnovers_avg_5, r.injury_status, r.lineup_role, r.news_flag, r.last_game_date]);
    downloadCsv(`fantasyscout-${league}-streamers.csv`, toCsv(header, body));
  };
  const select = 'rounded border border-line bg-card px-2 py-1';

  // the weeks to the end of the season, while any are left; the only grid when the window has no games (#450, #722)
  const weeksLeft = weeks.length > 0 && !complete;
  // the schedule card's views: the window's grid and the weeks to the end
  const scheduleViews = [
    ...(inWeek ? [{ id: 'window' as const, label: 'This window' }] : []),
    ...(weeksLeft ? [{ id: 'weeks' as const, label: 'Weeks to the end' }] : []),
  ];
  const shownSchedule = scheduleViews.some((v) => v.id === scheduleView) ? scheduleView : (scheduleViews[0]?.id ?? 'window');

  // the top adds' window and ranking, in words
  const windowText = period ? `from ${dayLabel(period.from)} to ${dayLabel(period.to)}` : horizonChoice === 'week' ? 'left this week' : `in the next ${horizon} days`;
  const needWords = [...needs].map((c) => CATEGORY_LABELS[c] ?? c).join(', ');
  const openWords = [...activePicked].sort().map(weekday).join(', ');
  const context = [
    needs.size ? `Ranked by the last ten games in ${needWords}` : 'Ranked by window value',
    activePicked.size ? `with a game on your open days (${openWords})` : null,
    rivalsIn
      ? 'from the players on no roster in your league'
      : `from the players outside the board's top ${leaguePool}, likely free in a league of ${setup.teams} × ${setup.rosterSpots}${hasRosters ? ' (add the other teams’ rosters to leave out exactly theirs)' : ''}`,
  ]
    .filter(Boolean)
    .join(', ')
    .concat('.');
  const reviewState: ReviewState = !hasRosters ? 'no-rosters' : boardFailed ? 'failed' : !boardRows ? 'loading' : reviewed ? 'ready' : 'no-team';
  const nameOf = (id: string) => (boardById.get(id)?.full_name as string | null | undefined) ?? rows.find((r) => r.player_id === id)?.full_name ?? id;
  const detailOf = (id: string) => [boardById.get(id)?.position, boardById.get(id)?.team_abbreviation].filter(Boolean).join(', ');

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
      ) : null}

      {leads && (
        <TopAdds
          adds={adds}
          league={league}
          windowText={windowText}
          context={context}
          review={reviewState}
          dropsLeft={(reviewed?.drops.length ?? 0) > 0}
          nameOf={nameOf}
          detailOf={detailOf}
          onApply={(add, drop) => updateLeague((s) => assign(assign(s, drop, null), add, s.mine))}
          onExplore={openExplore}
          openDays={activePicked.size > 0}
          notes={notes}
        />
      )}

      <details
        className="min-w-0 rounded-lg border border-line bg-card p-4"
        id="trending"
        data-testid="explore"
        open={leads ? exploreOpen : true}
        onToggle={(e) => {
          // only a choice counts: the list is always open when there are no top adds to lead with
          if (leads && e.currentTarget.open !== exploreOpen) rememberExplore(e.currentTarget.open);
        }}
      >
        <summary className="cursor-pointer text-sm font-medium tracking-wide text-muted uppercase" data-testid="explore-summary">
          {leads ? 'Explore all players' : scheduleError ? 'Trending up' : 'Finished strong'}
          {leads && <span className="ml-2 text-xs font-normal tracking-normal normal-case">the window, open days, needs, filters and the full table ({list.length} players)</span>}
        </summary>
        <div className="mt-3">
          <p className="mb-3 text-xs text-muted">
            The window value and the ranking on it:
            <Unvalidated issue={762} what="The window value" />
          </p>
          {inWeek && (
            <div data-testid="window-controls">
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
            </div>
          )}
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
              <label className="flex items-center gap-2 text-sm" title="Team, games played, minutes, the last five games' box score, the board rank and the last game">
                <input type="checkbox" checked={moreCols} onChange={(e) => setMoreCols(e.target.checked)} />
                More columns
              </label>
              <span className="text-sm text-muted">{list.length} players</span>
              <button type="button" onClick={exportCsv} className="rounded border border-line px-3 py-1 text-sm hover:bg-card" data-testid="streamers-csv">
                Export CSV
              </button>
            </div>
          </div>
          <TagLegend />
          <PickupsTable
            rows={list.slice(0, warm ? shown : Math.min(shown, FIRST_ROWS))}
            league={league}
            nextByTeam={nextByTeam}
            sortKey={sortKey}
            sortDir={sortDir}
            sortBy={sortBy}
            inWeek={inWeek}
            moreCols={moreCols}
            gamesLabel={period ? 'Period' : `Next ${horizon}`}
            gamesTitle={period ? `Team games from ${dayLabel(period.from)} to ${dayLabel(period.to)}` : `Team games in the next ${horizon} days`}
            points={points}
            dropped={dropped}
            needs={needs.size}
            openDays={activePicked.size}
            hasTrend={hasTrend}
            hasHeat={hasHeat}
            watched={watched}
            toggleWatched={toggleWatched}
          />
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
        </div>
      </details>

      {scheduleViews.length > 0 && (
        <details className="rounded-lg border border-line bg-card p-3" data-testid="schedule-card" id="schedule">
          <summary className="cursor-pointer text-sm font-medium tracking-wide text-muted uppercase">
            Schedule:{' '}
            {[
              inWeek ? (periodTitle ?? (horizonChoice === 'week' ? 'games left this fantasy week' : `games in the next ${horizon} days`)) : null,
              weeksLeft ? 'games per week to the end of the season' : null,
            ]
              .filter(Boolean)
              .join(', ')}
          </summary>
          {scheduleViews.length > 1 && (
            <div className="mt-2">
              <Segmented label="Schedule" value={shownSchedule} options={scheduleViews} onChange={setScheduleView} />
            </div>
          )}
          {inWeek && (
            <div className={`mt-3 ${shownSchedule === 'window' ? '' : 'hidden'}`}>
              <WeekGrid games={games} teams={teams} days={days} picked={activePicked} />
            </div>
          )}
          {weeksLeft && (
            <div className={`mt-3 ${shownSchedule === 'weeks' ? '' : 'hidden'}`} id="weeks">
              <p className="mb-3 text-sm text-muted">
                Monday-to-Sunday weeks from this one to the last scheduled game, regular season and playoffs. A team with four games is worth a streaming
                spot that week; two is a week to look elsewhere. &ldquo;+1&rdquo; is an if-necessary playoff game.
              </p>
              <WeeksGrid weeks={weeks} />
            </div>
          )}
        </details>
      )}

      {start && <RecentMoves moves={moves} league={league} start={start} minutes={(id) => minutesOf.get(id) ?? null} />}
    </div>
  );
}
