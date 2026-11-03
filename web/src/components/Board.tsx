import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { downloadCsv, toCsv } from '../lib/csv';
import { fetchBuildJson, fetchPageRows, type League } from '../lib/data';
import { useWarmUp } from '../lib/warm';
import { CATEGORIES, CATEGORY_LABELS, fmt, pct } from '../lib/format';
import { currentLeague, LEAGUE_LABEL } from '../lib/league';
import { eligibleAt, POSITION_LETTERS, type PositionLetter, sortRows, type SortDir, toggle } from '../lib/players';
import { href } from '../lib/site';
import { type BoardAvailability, type BoardView, readBoardFilters, writeBoardFilters } from '../lib/board-url';
import { useWatchlist } from '../lib/watchlist';
import { assign, draftPick, FOCUS_WEIGHT, owners, undoPick, useLeague } from '../lib/fantasy-league';
import { categoryValues, fitWeights, pointValues, type Tier } from '../lib/league-value';
import { reviewRoster, type RosterReview, type Upgrade } from '../lib/roster-upgrades';
import { matchup, matchupWeights, type WeekMatchup, weekTotals } from '../lib/matchup';
import { rivals, standingsModel, standingWeights, teamTotals as standingTotals, winChances } from '../lib/standings';
import { hasWeekGames, recentForm, type ValueUnit, weekValue } from '../lib/week-value';
import { DraftBar, LeagueBar, Matchup, Today, Upgrades } from './LeagueParts';
import { easternDate, type TodayGame } from '../lib/today';
import { Chip, InjuryTag, injuryDetail, LineupTag, Loading, NewsTag, RestRiskTag, NewTeam, Note, Problem, Segmented, Signed, SortTh, Star, TagLegend, Td, Th, TrendTag } from './ui';
import type { BoardColumn, ExportedRow } from '../generated/columns';
import { isLine, num, rankAndTier, restValues, scoreRows, zKey } from '../lib/board-model';

interface BoardRowFields {
  player_id: string;
  season: string;
  full_name: string | null;
  position: string | null;
  team_abbreviation: string | null;
  games_current: number | null;
  rank_total: number;
  value_total: number | null;
  value_rest_of_season: number | null;
  ros_factor: number | null;
  availability_multiplier: number | null;
  season_complete: boolean;
  games_remaining: number | null;
  games_next_7: number | null;
  /** Team games left this fantasy week, Monday to Sunday (absent in older builds). */
  games_this_week?: number | null;
  /** The newest flagged ESPN headline in the last three days. */
  news_flag?: string | null;
  news_headline?: string | null;
  news_date?: string | null;
  /** The game day the lineup role is for. */
  lineup_date?: string | null;
  /** rising or falling ESPN ownership. */
  ownership_trend?: string | null;
  /** Games the player is expected to miss, calibrated on past official listings. */
  expected_games_missed?: number | null;
  injury_status: string | null;
  injury_group: string | null;
  injury_type: string | null;
  expected_return: string | null;
  injury_note: string | null;
  injury_news?: string | null;
  injury_since?: string | null;
  /** official when the league's injury report sets the status for the next game, else espn. */
  injury_source?: string | null;
  official_game_date?: string | null;
  official_report_at?: string | null;
  lineup_role?: string | null;
  lineup_confirmed?: boolean | null;
  /** Where ESPN drafters take the player, and the gap to the board's rank (positive: a value). */
  market_rank?: number | null;
  market_gap?: number | null;
  ownership_bucket?: string | null;
  /** What the team still plays for, and a late-season rest risk (fct_team_stakes). */
  team_stakes?: string | null;
  rest_risk?: boolean | null;
  games_share: number | null;
  value_per_game: number | null;
  age: number | null;
  is_rookie: boolean | null;
  is_new_team: boolean | null;
  prev_team_abbreviation: string | null;
  proj_minutes_pg: number | null;
  [key: string]: unknown;
}
// Only columns the export ships (export/layout.py): a field it does not ship fails the type check (#479).
type BoardRow = ExportedRow<BoardColumn, BoardRowFields>;

type View = BoardView;

const VIEWS: { id: View; label: string; help: string }[] = [
  {
    id: 'value',
    label: 'Value',
    help: 'Value per game above replacement in your league, from each player’s projected line, times the share of games they are projected to play. Zero is a player you could pick up for free.',
  },
  { id: 'season', label: 'This season', help: 'Category z-scores over this season’s games.' },
  { id: 'last20', label: 'Last 20 games', help: 'Category z-scores over each player’s last twenty games this season.' },
  { id: 'recent', label: 'Last 10 games', help: 'Category z-scores over each player’s last ten games this season.' },
  {
    id: 'projected',
    label: 'Projected line',
    help: 'The per-game line the value is scored on: production per minute (seasons weighted by minutes played) times projected minutes, recent seasons counting more, starting from a replacement-level player.',
  },
  { id: 'pergame', label: 'Per game', help: 'This season’s per-game line; percentages are makes over attempts.' },
];

const LINE: { key: string; label: string; kind: 'num' | 'pct' }[] = [
  { key: 'minutes_pg', label: 'MIN', kind: 'num' },
  { key: 'points_pg', label: 'PTS', kind: 'num' },
  { key: 'rebounds_total_pg', label: 'REB', kind: 'num' },
  { key: 'assists_pg', label: 'AST', kind: 'num' },
  { key: 'steals_pg', label: 'STL', kind: 'num' },
  { key: 'blocks_pg', label: 'BLK', kind: 'num' },
  { key: 'three_pointers_made_pg', label: '3PM', kind: 'num' },
  { key: 'field_goal_pct', label: 'FG%', kind: 'pct' },
  { key: 'free_throw_pct', label: 'FT%', kind: 'pct' },
  { key: 'turnovers_pg', label: 'TO', kind: 'num' },
];

/** The columns of a line view: this season's line, or the projection's (proj_ prefix). */
function lineColumns(view: View): { key: string; label: string; kind: 'num' | 'pct' }[] {
  return LINE.map((c) => ({ ...c, key: view === 'projected' ? `proj_${c.key}` : c.key }));
}

type Availability = BoardAvailability;
type Show = 'available' | 'mine' | 'rostered' | 'all';

const PAGE = 100;
/** Rows in the first paint, before the rest of the page renders in idle time (#436). */
const FIRST_ROWS = 25;

/** How widely ESPN leagues roster a player, in words (fct_market_value buckets). */
const OWNED_LABEL: Record<string, string> = { most: 'most', many: 'many', some: 'some', few: 'few', rare: 'almost no' };
const COMPARE_MAX = 4;

const select = 'rounded border border-line bg-card px-2 py-1';

/** A row of mutually exclusive buttons. */
function roundsLabel(t: Tier): string {
  return t.firstRound === t.lastRound ? `round ${t.firstRound}` : `rounds ${t.firstRound}–${t.lastRound}`;
}

/** The row that opens a tier: where its picks fall in a draft, its value range, and how many are left. */
function TierHead({ tier, columns, left, size }: { tier: Tier | null; columns: number; left: number | null; size: number }) {
  return (
    <tr className="border-t-2 border-accent bg-bg" data-testid="tier-head">
      <td colSpan={columns} className="px-2 pt-2 pb-1 text-xs">
        <span className="sticky left-2 inline-block">
          {tier ? (
            <>
              <strong className="text-accent">Tier {tier.tier}</strong>{' '}
              <span className="text-muted">
                · {tier.start === tier.end ? `pick ${tier.start + 1}` : `picks ${tier.start + 1}–${tier.end + 1}`} ({roundsLabel(tier)}) · value {tier.start === tier.end ? fmt(tier.high, 1) : `${fmt(tier.high, 1)} to ${fmt(tier.low, 1)}`}
                {left !== null ? ` · ${left} of ${size} available` : ''}
              </span>
            </>
          ) : (
            <>
              <strong>Beyond the rostered pool</strong>{' '}
              <span className="text-muted">· players a league this size leaves on waivers</span>
            </>
          )}
        </span>
      </td>
    </tr>
  );
}

export default function Board() {
  const [league] = useState<League>(() => currentLeague());
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  // The view, punts and filters start from the URL and are written back to it, so a reload keeps
  // them and a copied link reproduces them (#461).
  const [fromUrl] = useState(() => readBoardFilters(window.location.search));
  const [view, setView] = useState<View>(fromUrl.view);
  const [restOfSeason, setRestOfSeason] = useState(fromUrl.restOfSeason);
  const [countGames, setCountGames] = useState(fromUrl.countGames);
  const [team, setTeam] = useState(fromUrl.team);
  const [positions, setPositions] = useState<Set<PositionLetter>>(fromUrl.positions);
  const [minGames, setMinGames] = useState(fromUrl.minGames);
  const [minMinutes, setMinMinutes] = useState(fromUrl.minMinutes);
  const [availability, setAvailability] = useState<Availability>(fromUrl.availability);
  const [rookiesOnly, setRookiesOnly] = useState(fromUrl.rookiesOnly);
  const [movedOnly, setMovedOnly] = useState(fromUrl.movedOnly);
  const [watchOnly, setWatchOnly] = useState(fromUrl.watchOnly);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState('value');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [shown, setShown] = useState(PAGE);
  // The first rows paint before the rest (#436): a slow phone shows the top of the board, and the
  // rest of the first page renders when the browser is idle.
  const warm = useWarmUp(!!rows);
  const [compare, setCompare] = useState<string[]>([]);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [showChoice, setShowChoice] = useState<Show | null>(null);
  const { watched, toggleWatched } = useWatchlist(league);
  const [setup, updateLeague] = useLeague(league);
  // Punts are the league's (#661): these chips edit the setting the League page does, and the
  // Trade page, the upgrades and Streamers read it.
  const punts = useMemo(() => new Set(setup.punts), [setup.punts]);
  const setPunts = useCallback(
    (change: Set<string> | ((current: Set<string>) => Set<string>)) =>
      updateLeague((s) => ({ ...s, punts: [...(typeof change === 'function' ? change(new Set(s.punts)) : change)] })),
    [updateLeague],
  );
  // A link carrying ?punt= applies its punts to the league, so a copied link still reproduces them.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('punt')) setPunts(fromUrl.punts);
  }, [fromUrl, setPunts]);
  useEffect(() => {
    const filters = { view, punts, restOfSeason, countGames, team, positions, minGames, minMinutes, availability, rookiesOnly, movedOnly, watchOnly };
    const qs = writeBoardFilters(window.location.search, filters);
    if (qs !== window.location.search) window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs}${window.location.hash}`);
  }, [view, punts, restOfSeason, countGames, team, positions, minGames, minMinutes, availability, rookiesOnly, movedOnly, watchOnly]);
  const owner = useMemo(() => owners(setup), [setup]);
  const hasRosters = owner.size > 0;
  // With rosters in, the board starts on the players still available.
  const show: Show = showChoice ?? (hasRosters ? 'available' : 'all');
  const points = setup.scoring === 'points';
  const pool = setup.teams * setup.rosterSpots;
  // 8-cat leagues drop turnovers; on top of that, the manager's own punts.
  const punted = useMemo(() => (setup.scoring === 'cats8' ? new Set([...punts, 'z_turnovers']) : punts), [punts, setup.scoring]);
  const activeCats = useMemo(() => CATEGORIES.filter((c) => !punted.has(c)), [punted]);
  // Focus categories count more in value and Fit (#680).
  const focus = useMemo(() => Object.fromEntries(activeCats.map((c) => [c, setup.focus.includes(c) ? FOCUS_WEIGHT : 1])), [activeCats, setup.focus]);
  const views = points ? VIEWS.filter((v) => v.id === 'value' || v.id === 'projected') : VIEWS;
  useEffect(() => {
    if (points && view !== 'value' && view !== 'projected') setView('value');
  }, [points, view]);

  useEffect(() => {
    let live = true;
    fetchPageRows<BoardRow>(`board/${league}`)
      .then((data) => live && setRows(data))
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, [league]);

  // The schedule, for the Today card (#464): fetched after the board, so it never holds up the first rows.
  const [games, setGames] = useState<TodayGame[] | null>(null);
  useEffect(() => {
    if (!rows) return;
    let live = true;
    fetchBuildJson<TodayGame[]>(`schedule/${league}.json`)
      .then((g) => live && setGames(g))
      .catch(() => live && setGames(null));
    return () => {
      live = false;
    };
  }, [rows, league]);

  const meta = useMemo(() => {
    const list = rows ?? [];
    const season = list[0]?.season ?? '';
    const complete = list.length > 0 && list.every((r) => r.season_complete);
    const maxGames = list.reduce((m, r) => Math.max(m, r.games_current ?? 0), 0);
    const remaining = list.reduce((m, r) => Math.max(m, r.games_remaining ?? 0), 0);
    const teams = [...new Set(list.map((r) => r.team_abbreviation).filter((t): t is string => !!t))].sort();
    const injured = list.filter((r) => r.injury_group).length;
    return { season, complete, maxGames, remaining, teams, injured };
  }, [rows]);

  // Category values above this league's replacement level, and points if the league scores points.
  const leagueCats = useMemo(
    () => (rows && !points ? categoryValues(rows, activeCats, pool, setup.teams) : null),
    [rows, points, activeCats, pool, setup.teams],
  );
  const leaguePoints = useMemo(
    () => (rows && points ? pointValues(rows, setup.weights, pool, setup.teams) : null),
    [rows, points, setup.weights, pool, setup.teams],
  );

  // The manager's team: its category totals set how much each category counts in Fit.
  // The manager's team, without players parked on the injured list.
  const myTeam = useMemo(
    () => (rows ?? []).filter((r) => owner.get(r.player_id) === setup.mine && !setup.il.includes(r.player_id)),
    [rows, owner, setup.mine, setup.il],
  );
  const teamTotals = useMemo(() => {
    if (!leagueCats || myTeam.length === 0) return null;
    return Object.fromEntries(activeCats.map((c) => [c, myTeam.reduce((s, r) => s + (leagueCats.get(r.player_id)?.[c] ?? 0), 0)]));
  }, [leagueCats, myTeam, activeCats]);
  const rotoWeights = useMemo(() => (teamTotals ? fitWeights(teamTotals) : null), [teamTotals]);
  const rotoWeakest = useMemo(
    () => (teamTotals ? Object.entries(teamTotals).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([c]) => c) : []),
    [teamTotals],
  );

  // Rest-of-season value under the league's scoring, the scale the Trade page uses, whatever view the board is on.
  const restValue = useMemo(
    () => restValues(rows ?? [], { points, leaguePoints, leagueCats, activeCats, focus }),
    [rows, points, leaguePoints, leagueCats, activeCats, focus],
  );
  // The fantasy-week unit (#466): recent form over the games left this week, offered while the week has games.
  const [unit, setUnit] = useState<ValueUnit>(setup.format === 'h2h' ? 'week' : 'rest');
  const weekAvailable = useMemo(() => !!rows && hasWeekGames(rows), [rows]);
  const week = unit === 'week' && weekAvailable;
  const weekCats = useMemo(
    () => (rows && !points && week ? categoryValues(recentForm(rows, activeCats), activeCats, pool, setup.teams) : null),
    [rows, points, week, activeCats, pool, setup.teams],
  );
  const weekValues = useMemo(() => {
    const out = new Map<string, number>();
    if (!week) return out;
    for (const r of rows ?? []) {
      const perGame = points
        ? (leaguePoints?.get(r.player_id)?.value ?? 0)
        : activeCats.reduce((s, c) => s + (focus[c] ?? 1) * (weekCats?.get(r.player_id)?.[c] ?? 0), 0);
      out.set(r.player_id, weekValue(perGame, r.games_this_week));
    }
    return out;
  }, [rows, week, points, leaguePoints, weekCats, activeCats, focus]);
  // Head-to-head (#490): the week's projected totals against the chosen opponent set Fit and the categories the bar names.
  const h2h = setup.format === 'h2h';
  const opponentRows = useMemo(
    () =>
      h2h && setup.opponent !== null
        ? (rows ?? []).filter((r) => owner.get(r.player_id) === setup.opponent && !setup.il.includes(r.player_id))
        : [],
    [h2h, rows, owner, setup.opponent, setup.il],
  );
  const match = useMemo<WeekMatchup | null>(() => {
    if (!h2h || setup.opponent === null || !weekAvailable || myTeam.length === 0) return null;
    const scoring = points ? setup.weights : undefined;
    return matchup(points ? [] : activeCats, weekTotals(myTeam, activeCats, scoring), weekTotals(opponentRows, activeCats, scoring));
  }, [h2h, setup.opponent, setup.weights, weekAvailable, myTeam, opponentRows, activeCats, points]);
  // The league standings (#662): every team's totals, each player counted by the share of the
  // games left he is expected to play, and the chance of beating each rival in each kept category.
  const standings = useMemo(() => {
    if (!rows || !leagueCats || myTeam.length === 0) return null;
    const others = rivals(setup.rosters, setup.mine, setup.rosterSpots);
    if (!others.length) return null;
    const availability = new Map(rows.map((r) => [r.player_id, r.availability_multiplier ?? 1]));
    const active = setup.rosters.map((r) => r.filter((id) => !setup.il.includes(id)));
    const totals = active.map((r) => standingTotals(r, activeCats, (id) => leagueCats.get(id), (id) => availability.get(id) ?? 1));
    const ranked = [setup.mine, ...others];
    const players = ranked.reduce((s, t) => s + (active[t] ?? []).reduce((n, id) => n + (availability.get(id) ?? 1), 0), 0) / ranked.length;
    const model = standingsModel(league, activeCats, players, setup.format, meta.remaining);
    return { weights: standingWeights(totals, setup.mine, others, model), chances: winChances(totals, setup.mine, others, model) };
  }, [rows, leagueCats, myTeam.length, setup.rosters, setup.mine, setup.rosterSpots, setup.il, setup.format, activeCats, league, meta.remaining]);
  // Fit: this week's matchup while judging the week; otherwise the league standings, or the
  // manager's own totals when no other team's roster is in.
  const weekMatch = week && match && !points ? match : null;
  const weights = useMemo(
    () => (weekMatch ? matchupWeights(weekMatch.cats) : (standings?.weights ?? rotoWeights)),
    [weekMatch, standings, rotoWeights],
  );
  const weakest = useMemo(() => {
    if (weekMatch) return weekMatch.cats.filter((r) => r.result !== 'win').sort((a, b) => a.share - b.share).slice(0, 3).map((r) => r.cat);
    if (standings) return Object.entries(standings.chances).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([c]) => c);
    return rotoWeakest;
  }, [weekMatch, standings, rotoWeakest]);
  // Available players worth more than one of the manager's, in the unit chosen: the swaps the manager can make.
  const review = useMemo<RosterReview | null>(() => {
    if (!rows || myTeam.length === 0 || setup.drafting) return null;
    const cats = week && weekCats ? weekCats : leagueCats;
    const totals = setup.rosters.map((roster) =>
      Object.fromEntries(
        activeCats.map((c) => [c, roster.filter((id) => !setup.il.includes(id)).reduce((s, id) => s + (cats?.get(id)?.[c] ?? 0), 0)]),
      ),
    );
    const positions = new Map(rows.map((r) => [r.player_id, r.position]));
    return reviewRoster({
      position: (id) => positions.get(id),
      mine: myTeam.map((r) => r.player_id),
      available: rows.filter((r) => !owner.has(r.player_id)).map((r) => r.player_id),
      rest: week ? weekValues : restValue,
      cats: points ? [] : activeCats,
      catValue: (id) => cats?.get(id),
      totals,
      myTeam: setup.mine,
    });
  }, [rows, myTeam, setup, activeCats, leagueCats, owner, restValue, points, week, weekCats, weekValues]);
  const applyUpgrade = useCallback(
    (u: Upgrade) => updateLeague((s) => assign(assign(s, u.drop, null), u.add, s.mine)),
    [updateLeague],
  );

  const scored = useMemo(
    () => scoreRows(rows ?? [], { view, points, activeCats, countGames, restOfSeason, leagueCats, leaguePoints, weights, focus }),
    [rows, view, points, activeCats, restOfSeason, countGames, leagueCats, leaguePoints, weights, focus],
  );

  // Position ranks and tiers, over every player in the current value order.
  const { posRank, overall, tiers } = useMemo(
    () => rankAndTier(scored, { view, teams: setup.teams, rosterSpots: setup.rosterSpots, owned: (id) => owner.has(id) }),
    [scored, view, setup.teams, setup.rosterSpots, owner],
  );

  // The market's rank against this board's, under the league's settings (the export's market_gap is
  // the default league's).
  const marketGap = useCallback(
    (r: BoardRow): number | null => {
      const here = overall.get(r.player_id);
      return r.market_rank == null || here === undefined ? null : r.market_rank - here;
    },
    [overall],
  );

  const ranked = useMemo(() => {
    const q = query.toLowerCase();
    const filtered = scored
      .filter(({ row }) => !team || row.team_abbreviation === team)
      .filter(({ row }) => eligibleAt(row.position, positions))
      .filter(({ row }) => (row.games_current ?? 0) >= minGames)
      .filter(({ row }) => (row.proj_minutes_pg ?? 0) >= minMinutes)
      .filter(({ row }) => availability === 'all' || (availability === 'no_out' ? row.injury_group !== 'out' : !row.injury_group || row.injury_group === 'probable'))
      .filter(({ row }) => !rookiesOnly || row.is_rookie === true)
      .filter(({ row }) => !movedOnly || row.is_new_team === true)
      .filter(({ row }) => !watchOnly || watched.has(row.player_id))
      .filter(({ row }) =>
        show === 'all' ||
        (show === 'mine' ? owner.get(row.player_id) === setup.mine : show === 'rostered' ? owner.has(row.player_id) : !owner.has(row.player_id)),
      )
      .filter(({ row }) => !q || (row.full_name ?? '').toLowerCase().includes(q))
      .filter(({ value }) => view === 'value' || value !== null);
    const get = (s: (typeof filtered)[number]): number | string | null => {
      if (sortKey === 'value') return s.value;
      if (sortKey === 'fit') return s.fit;
      if (sortKey === 'fpts') return leaguePoints?.get(s.row.player_id)?.fpts ?? null;
      if (sortKey === 'market_gap') return marketGap(s.row);
      if (sortKey === 'name') return s.row.full_name;
      if (sortKey === 'team') return s.row.team_abbreviation;
      if (sortKey === 'pos') return s.row.position;
      return num(s.row, sortKey);
    };
    return sortRows(filtered, get, sortDir);
  }, [scored, team, positions, minGames, minMinutes, availability, rookiesOnly, movedOnly, watchOnly, watched, show, owner, setup.mine, query, sortKey, sortDir, view, leaguePoints, marketGap]);

  if (error) return <Problem error={error} />;
  if (!rows) return <Loading what="the board" />;

  const sortBy = (key: string, defaultDir: SortDir = 'desc') => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      setSortDir(defaultDir);
    }
  };
  const pickView = (v: View) => {
    setView(v);
    setSortKey('value');
    setSortDir('desc');
  };
  const toggleCompare = (id: string) =>
    setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= COMPARE_MAX ? c : [...c, id]));
  const showNext7 = !meta.complete;
  type Column = { key: string; label: string; kind: 'num' | 'pct' | 'z' | 'fpts'; category?: string };
  const categoryColumns: Column[] = isLine(view)
    ? lineColumns(view).map((c) => ({ key: c.key, label: c.label, kind: c.kind }))
    : view === 'value' && points
      ? [{ key: 'fpts', label: 'FPts/G', kind: 'fpts' }, ...lineColumns('projected').map((c) => ({ key: c.key, label: c.label, kind: c.kind }))]
      : CATEGORIES.map((c) => ({ key: zKey(view, c), label: CATEGORY_LABELS[c] ?? c, category: c, kind: 'z' as const }));
  /** A category cell: in the value view, measured against this league's replacement level. */
  const catValue = (row: BoardRow, c: string): number | null => {
    if (punted.has(c)) return null;
    if (view === 'value' && leagueCats) return leagueCats.get(row.player_id)?.[c] ?? null;
    return num(row, zKey(view, c));
  };
  const showFit = view === 'value' && !points && myTeam.length > 0;
  const showTiers = tiers !== null && sortKey === 'value' && sortDir === 'desc';
  const fitOf = new Map(scored.map((s) => [s.row.player_id, s.fit]));
  const byId = new Map(rows.map((r) => [r.player_id, r]));
  const compared = compare.map((id) => byId.get(id)).filter((r): r is BoardRow => !!r);
  const valueOf = new Map(scored.map((s) => [s.row.player_id, s.value]));
  // The market's columns: in the value view, once the build carries ESPN's market.
  // The market columns only when the market ranks someone: the WNBA has ownership but no draft
  // position, which left a column of dashes (#451). Its trend arrow then sits with the name tags.
  const showMarket = view === 'value' && rows.some((r) => r.market_rank != null);
  const columns =
    6 + (view === 'value' ? 1 : 0) + (showNext7 ? 2 : 0) + categoryColumns.length + (showFit ? 1 : 0) + (showMarket ? 2 : 0) + (isLine(view) ? 0 : 1) + 1;
  const lastPick = setup.picks.at(-1);
  const ownerName = (id: string) => {
    const t = owner.get(id);
    return t === undefined ? null : t === setup.mine ? 'Mine' : (setup.names[t] ?? null);
  };

  // Filters and options behind the Filters button, each shown as a chip while it applies.
  const active: { label: string; clear: () => void }[] = [
    ...(!isLine(view) && !points ? [...punts].map((c) => ({ label: `Punt ${CATEGORY_LABELS[c] ?? c}`, clear: () => setPunts((p) => toggle(p, c)) })) : []),
    ...(view === 'value' && !countGames ? [{ label: 'Games played not counted', clear: () => setCountGames(true) }] : []),
    ...(view === 'value' && restOfSeason && !meta.complete ? [{ label: 'Rest of season', clear: () => setRestOfSeason(false) }] : []),
    ...(team ? [{ label: `Team ${team}`, clear: () => setTeam('') }] : []),
    ...(minGames ? [{ label: `${minGames}+ games`, clear: () => setMinGames(0) }] : []),
    ...(minMinutes ? [{ label: `${minMinutes}+ MPG`, clear: () => setMinMinutes(0) }] : []),
    ...(availability !== 'all' ? [{ label: availability === 'healthy' ? 'Healthy only' : 'No players ruled out', clear: () => setAvailability('all') }] : []),
    ...(rookiesOnly ? [{ label: 'Rookies', clear: () => setRookiesOnly(false) }] : []),
    ...(movedOnly ? [{ label: 'Changed teams', clear: () => setMovedOnly(false) }] : []),
    ...(watchOnly ? [{ label: 'Watchlist', clear: () => setWatchOnly(false) }] : []),
  ];

  const exportCsv = () => {
    const header = ['rank', 'player', 'team', 'position', 'age', 'rookie', 'new_team_from', 'games', 'games_share', ...categoryColumns.map((c) => c.label)];
    if (!isLine(view)) header.push('total');
    header.push('tier', 'fantasy_team');
    const body = ranked.map(({ row, value }, i) => {
      const cells: (string | number | boolean | null)[] = [
        i + 1,
        row.full_name,
        row.team_abbreviation,
        row.position,
        row.age,
        row.is_rookie,
        row.is_new_team ? row.prev_team_abbreviation : null,
        row.games_current,
        row.games_share,
        ...categoryColumns.map((c) =>
          c.kind === 'fpts' ? (leaguePoints?.get(row.player_id)?.fpts ?? null) : c.category ? catValue(row, c.category) : num(row, c.key),
        ),
      ];
      if (!isLine(view)) cells.push(value);
      const t = owner.get(row.player_id);
      cells.push(tiers?.of.get(row.player_id) ?? null, t === undefined ? null : (setup.names[t] ?? null));
      return cells;
    });
    downloadCsv(`fantasyscout-${league}-board-${view}.csv`, toCsv(header, body));
  };

  const body: ReactNode[] = [];
  let currentTier: number | undefined;
  ranked.slice(0, warm ? shown : Math.min(shown, FIRST_ROWS)).forEach(({ row, value }, i) => {
    if (showTiers) {
      const t = tiers.of.get(row.player_id) ?? 0;
      if (t !== currentTier) {
        const tier = tiers.list[t - 1] ?? null;
        body.push(
          <TierHead
            key={`tier-${t}`}
            tier={tier}
            columns={columns}
            left={hasRosters && tier ? (tiers.left.get(t) ?? 0) : null}
            size={tier ? tier.end - tier.start + 1 : 0}
          />,
        );
        currentTier = t;
      }
    }
    const held = ownerName(row.player_id);
    body.push(
      <tr
        key={row.player_id}
        className={`border-t border-line ${held === 'Mine' ? 'bg-good/10' : held ? 'text-muted' : ''}`}
        data-player={row.player_id}
        data-mine={held === 'Mine' ? '' : undefined}
      >
        <Td right pin="first">
          {i + 1}
        </Td>
        <Td pin="second">
          <span className="flex items-center gap-1 whitespace-nowrap">
            {setup.drafting && !held && (
              <button
                type="button"
                onClick={() => updateLeague((s) => draftPick(s, row.player_id))}
                className="rounded border border-accent px-1.5 text-xs text-accent hover:bg-accent hover:text-accent-fg"
                aria-label={`Draft ${row.full_name ?? row.player_id}`}
                data-testid="draft"
              >
                Draft
              </button>
            )}
            <Star on={watched.has(row.player_id)} label={row.full_name ?? row.player_id} onToggle={() => toggleWatched(row.player_id)} />
            <a href={href(`/p/${league}/${row.player_id}/`)} className="underline-offset-4 hover:underline">
              {row.full_name ?? row.player_id}
            </a>
            {row.is_rookie && (
              <span className="rounded border border-line px-1 text-[10px] text-muted" title="Rookie">
                R
              </span>
            )}
            {row.is_new_team && <NewTeam from={row.prev_team_abbreviation} />}
            <LineupTag role={row.lineup_role} confirmed={row.lineup_confirmed} date={row.lineup_date} injuryGroup={row.injury_group} />
            <RestRiskTag risk={row.rest_risk} stakes={row.team_stakes} />
            <NewsTag flag={row.news_flag} headline={row.news_headline} date={row.news_date} />
            {!showMarket && <TrendTag trend={row.ownership_trend} />}
            <InjuryTag
              group={row.injury_group}
              status={row.injury_status}
              detail={[injuryDetail(row)]
                .filter(Boolean)
                .join(' · ')}
            />
            {held && (
              <span
                className={`max-w-[9rem] truncate rounded border px-1 text-[10px] ${held === 'Mine' ? 'border-good text-good' : 'border-line'}`}
                title={held === 'Mine' ? 'On your team' : `On ${held}`}
                data-testid="owner"
              >
                {held}
              </span>
            )}
            {held === 'Mine' && review?.replace.includes(row.player_id) && (
              <span
                className="rounded border border-warn px-1 text-[10px] text-warn"
                title="A player nobody owns is worth more for the rest of the season: see Roster review"
                data-testid="replace-tag"
              >
                Replace
              </span>
            )}
          </span>
        </Td>
        <Td>{row.team_abbreviation ?? '–'}</Td>
        <Td>
          {row.position ?? '–'}
          {posRank.get(row.player_id) && (
            <span className="ml-1 text-[10px] text-muted" title="Rank among players at this position" data-testid="pos-rank">
              {posRank.get(row.player_id)}
            </span>
          )}
        </Td>
        <Td right>{row.age ?? '–'}</Td>
        <Td right>{row.games_current ?? 0}</Td>
        {view === 'value' && <Td right>{pct(row.games_share)}</Td>}
        {showNext7 && <Td right>{row.games_next_7 ?? 0}</Td>}
        {showNext7 && <Td right>{row.games_this_week ?? 0}</Td>}
        {categoryColumns.map((c) => (
          <Td key={c.key} right>
            {c.kind === 'fpts' ? (
              fmt(leaguePoints?.get(row.player_id)?.fpts ?? null, 1)
            ) : c.kind === 'z' ? (
              <Signed value={c.category ? catValue(row, c.category) : null} />
            ) : c.kind === 'pct' ? (
              pct(num(row, c.key))
            ) : (
              fmt(num(row, c.key))
            )}
          </Td>
        ))}
        {showFit && (
          <Td right>
            <Signed value={fitOf.get(row.player_id) ?? null} />
          </Td>
        )}
        {showMarket && (
          <Td right>
            <span title={row.ownership_bucket ? `Rostered in ${OWNED_LABEL[row.ownership_bucket] ?? row.ownership_bucket} ESPN leagues` : undefined} data-testid="market-rank">
              {row.market_rank ?? '–'}
            </span>{' '}
            <TrendTag trend={row.ownership_trend} />
          </Td>
        )}
        {showMarket && (
          <Td right>
            <span data-testid="market-gap">
              <Signed value={marketGap(row)} digits={0} />
            </span>
          </Td>
        )}
        {!isLine(view) && (
          <Td right>
            <strong>{fmt(value, 2)}</strong>
          </Td>
        )}
        <Td>
          {/* The label pads the box to a 24 by 24 target (#457). */}
          <label className="-m-1 inline-flex cursor-pointer p-1">
            <input
              type="checkbox"
              className="size-4"
              aria-label={`Compare ${row.full_name ?? row.player_id}`}
              checked={compare.includes(row.player_id)}
              disabled={!compare.includes(row.player_id) && compare.length >= COMPARE_MAX}
              onChange={() => toggleCompare(row.player_id)}
            />
          </label>
        </Td>
      </tr>,
    );
  });

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      {meta.complete ? (
        <Note testid="season-note">
          The {LEAGUE_LABEL[league]} {meta.season} regular season is over. Values project next season from this one and the two before it, for
          players on a current roster; rest-of-season ranking returns when the next schedule is out.
        </Note>
      ) : (
        <Note testid="season-note">
          {LEAGUE_LABEL[league]} {meta.season}: up to {meta.maxGames} game{meta.maxGames === 1 ? '' : 's'} played and up to {meta.remaining} left
          per team.
          {meta.maxGames < 20 ? ' Projections count this season by games played, so a few games move a value only a little.' : ''}
          {meta.injured ? ` ${meta.injured} players are on the current injury report.` : ''}
        </Note>
      )}

      <LeagueBar
        setup={setup}
        rostered={owner.size}
        myCount={myTeam.length}
        weakest={view === 'value' ? weakest : []}
        weakLabel={weekMatch ? 'Behind this week' : 'Weakest'}
      />
      {h2h && owner.size > 0 && !setup.drafting && weekAvailable && (
        <Matchup setup={setup} match={match} points={points} onOpponent={(t) => updateLeague((s) => ({ ...s, opponent: t }))} />
      )}
      {games && myTeam.length > 0 && !setup.drafting && <Today league={league} players={myTeam} games={games} date={easternDate()} />}
      {review && (
        <Upgrades
          league={league}
          review={review}
          nameOf={(id) => byId.get(id)?.full_name ?? id}
          detailOf={(id) => [byId.get(id)?.position, byId.get(id)?.team_abbreviation].filter(Boolean).join(', ')}
          onApply={applyUpgrade}
          unit={week ? 'week' : 'rest'}
          onUnit={weekAvailable ? setUnit : null}
          gamesOf={(id) => byId.get(id)?.games_this_week ?? 0}
        />
      )}
      {setup.drafting && (
        <DraftBar
          setup={setup}
          lastName={lastPick ? (byId.get(lastPick.player)?.full_name ?? null) : null}
          onUndo={() => updateLeague(undoPick)}
          onEnd={() => updateLeague((s) => ({ ...s, drafting: false }))}
        />
      )}

      <div className="grid gap-1">
        <Segmented label="Value view" value={view} options={views.map((v) => ({ id: v.id, label: v.label, title: v.help }))} onChange={pickView} />
        <p className="text-xs text-muted">{VIEWS.find((v) => v.id === view)?.help}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2" data-testid="board-filters">
        <label className="text-sm">
          <span className="sr-only">Search player</span>
          <input type="search" placeholder="Search player" value={query} onChange={(e) => setQuery(e.target.value)} className={`${select} w-40`} />
        </label>
        <div className="flex items-center gap-1" role="group" aria-label="Position">
          {POSITION_LETTERS.map((p) => (
            <Chip key={p} label={`Position ${p}`} checked={positions.has(p)} onChange={() => setPositions(toggle(positions, p))}>
              {p}
            </Chip>
          ))}
        </div>
        {hasRosters && (
          <Segmented
            label="Show"
            value={show}
            options={[
              { id: 'available', label: 'Available' },
              { id: 'mine', label: 'My team' },
              { id: 'rostered', label: 'Rostered' },
              { id: 'all', label: 'Everyone' },
            ]}
            onChange={setShowChoice}
          />
        )}
        <button
          type="button"
          aria-expanded={optionsOpen}
          aria-controls="board-options"
          onClick={() => setOptionsOpen(!optionsOpen)}
          className={`rounded border px-3 py-1 text-sm ${optionsOpen ? 'border-accent' : 'border-line'} hover:bg-card`}
          data-testid="board-options-toggle"
        >
          Filters{active.length ? ` (${active.length})` : ''} {optionsOpen ? '▴' : '▾'}
        </button>
        <span className="ml-auto text-sm text-muted">{ranked.length} players</span>
        <button type="button" onClick={exportCsv} className="rounded border border-line px-3 py-1 text-sm hover:bg-card" data-testid="board-csv">
          Export CSV
        </button>
      </div>

      {optionsOpen && (
        <div id="board-options" className="grid gap-4 rounded-lg border border-line bg-card p-3 text-sm md:grid-cols-2" data-testid="board-options">
          <fieldset className="grid content-start gap-2">
            <legend className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Players</legend>
            <div className="flex flex-wrap items-center gap-3">
              <label>
                <span className="sr-only">NBA or WNBA team</span>
                <select value={team} onChange={(e) => setTeam(e.target.value)} className={select} aria-label="Team">
                  <option value="">All teams</option>
                  {meta.teams.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="sr-only">Health</span>
                <select value={availability} onChange={(e) => setAvailability(e.target.value as Availability)} className={select} aria-label="Health">
                  <option value="all">Any health</option>
                  <option value="no_out">Hide players ruled out</option>
                  <option value="healthy">Healthy only</option>
                </select>
              </label>
              <label>
                Min games{' '}
                <select value={minGames} onChange={(e) => setMinGames(Number(e.target.value))} className={select}>
                  {[0, 5, 10, 20].map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </label>
              <label title="Projected minutes per game">
                Min MPG{' '}
                <select value={minMinutes} onChange={(e) => setMinMinutes(Number(e.target.value))} className={select}>
                  {[0, 15, 20, 25, 30].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={rookiesOnly} onChange={(e) => setRookiesOnly(e.target.checked)} />
                Rookies only
              </label>
              <label className="flex items-center gap-2" title="Players whose current team differs from last season's">
                <input type="checkbox" checked={movedOnly} onChange={(e) => setMovedOnly(e.target.checked)} />
                Changed teams
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={watchOnly} onChange={(e) => setWatchOnly(e.target.checked)} />
                Watchlist only ({watched.size})
              </label>
            </div>
          </fieldset>
          {!isLine(view) && (
            <fieldset className="grid content-start gap-2">
              <legend className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">{points ? 'Value' : 'Punt (drop from the total)'}</legend>
              {!points && (
                <div className="flex flex-wrap gap-1">
                  {CATEGORIES.map((c) => (
                    <Chip
                      key={c}
                      checked={punted.has(c)}
                      strike
                      onChange={() => setPunts(toggle(punts, c))}
                      disabled={setup.scoring === 'cats8' && c === 'z_turnovers'}
                      title={setup.scoring === 'cats8' && c === 'z_turnovers' ? 'An 8-category league does not count turnovers: there is nothing to punt' : undefined}
                    >
                      {CATEGORY_LABELS[c]}
                    </Chip>
                  ))}
                </div>
              )}
              {!points && (
                <p className="text-xs text-muted">
                  {setup.focus.length
                    ? `Focus: ${setup.focus.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}, counted ${FOCUS_WEIGHT}× (`
                    : `Focus categories, counted ${FOCUS_WEIGHT}×, are set on the `}
                  <a href={href('/league/')} className="underline underline-offset-4">
                    {setup.focus.length ? 'change on the League page' : 'League page'}
                  </a>
                  {setup.focus.length ? ').' : '.'}
                </p>
              )}
              {view === 'value' && (
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2" title="Multiply value per game by the projected share of team games played">
                    <input type="checkbox" checked={countGames} onChange={(e) => setCountGames(e.target.checked)} />
                    Count games played
                  </label>
                  <label className={`flex items-center gap-2 ${meta.complete ? 'text-muted' : ''}`} title="Value above replacement × games left × availability">
                    <input type="checkbox" checked={restOfSeason && !meta.complete} disabled={meta.complete} onChange={(e) => setRestOfSeason(e.target.checked)} />
                    Rest of season
                  </label>
                </div>
              )}
            </fieldset>
          )}
        </div>
      )}

      {active.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" data-testid="active-filters">
          {active.map((f) => (
            <button
              key={f.label}
              type="button"
              onClick={f.clear}
              className="rounded-full border border-accent px-2.5 py-0.5 text-xs text-accent hover:bg-accent hover:text-accent-fg"
              aria-label={`Remove ${f.label}`}
            >
              {f.label} ×
            </button>
          ))}
          {active.length > 1 && (
            <button type="button" onClick={() => active.forEach((f) => f.clear())} className="px-2 text-xs text-muted underline-offset-4 hover:underline">
              Clear all
            </button>
          )}
        </div>
      )}

      {compared.length > 0 && (
        <section className="min-w-0 rounded-lg border border-line bg-card p-3" aria-labelledby="compare-h" data-testid="compare">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="compare-h" className="text-sm font-medium tracking-wide text-muted uppercase">
              Compare ({compared.length}/{COMPARE_MAX})
            </h2>
            <button type="button" onClick={() => setCompare([])} className="rounded border border-line px-2 py-0.5 text-xs hover:bg-bg">
              Clear
            </button>
          </div>
          <div className="table-scroll mt-2 max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="Player comparison">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th>{isLine(view) ? 'Value view' : (VIEWS.find((v) => v.id === view)?.label ?? '')}</Th>
                  {compared.map((r) => (
                    <Th key={r.player_id} right>
                      {r.full_name}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ...CATEGORIES.map((c) => ({
                    label: CATEGORY_LABELS[c] ?? c,
                    get: (r: BoardRow) => (punted.has(c) ? null : (leagueCats?.get(r.player_id)?.[c] ?? num(r, zKey(isLine(view) ? 'value' : view, c)))),
                    kind: 'z',
                  })),
                  { label: 'Total', get: (r: BoardRow) => (isLine(view) ? r.value_total : (valueOf.get(r.player_id) ?? null)), kind: 'z' },
                  { label: 'GP%', get: (r: BoardRow) => r.games_share, kind: 'pct' },
                  ...LINE.map((l) => ({ label: `${l.label} (proj)`, get: (r: BoardRow) => num(r, `proj_${l.key}`), kind: l.kind })),
                ].map((m) => {
                  const values = compared.map((r) => m.get(r));
                  const better = m.label.startsWith('TO (') ? Math.min : Math.max;
                  const known = values.filter((v): v is number => typeof v === 'number');
                  const best = known.length > 1 ? better(...known) : null;
                  return (
                    <tr key={m.label} className="border-t border-line">
                      <Td>{m.label}</Td>
                      {values.map((v, i) => (
                        <Td key={compared[i]?.player_id} right>
                          <span className={best !== null && v === best ? 'font-semibold' : ''}>
                            {m.kind === 'z' ? <Signed value={v} /> : m.kind === 'pct' ? pct(v) : fmt(v)}
                          </span>
                        </Td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <TagLegend />
      <div className="table-scroll max-h-[70vh] overflow-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="Player board">
        <table className="w-full text-sm" data-testid="board">
          <thead className="bg-card">
            <tr>
              <Th right pin="first">#</Th>
              <SortTh active={sortKey === 'name'} dir={sortDir} onClick={() => sortBy('name', 'asc')} pin="second">
                Player
              </SortTh>
              <SortTh active={sortKey === 'team'} dir={sortDir} onClick={() => sortBy('team', 'asc')}>
                Team
              </SortTh>
              <SortTh active={sortKey === 'pos'} dir={sortDir} onClick={() => sortBy('pos', 'asc')}>
                Pos
              </SortTh>
              <SortTh right active={sortKey === 'age'} dir={sortDir} onClick={() => sortBy('age', 'asc')}>
                Age
              </SortTh>
              <SortTh right active={sortKey === 'games_current'} dir={sortDir} onClick={() => sortBy('games_current')} title="Games this season">
                GP
              </SortTh>
              {view === 'value' && (
                <SortTh right active={sortKey === 'games_share'} dir={sortDir} onClick={() => sortBy('games_share')} title="Projected share of team games played">
                  GP%
                </SortTh>
              )}
              {showNext7 && (
                <SortTh right active={sortKey === 'games_next_7'} dir={sortDir} onClick={() => sortBy('games_next_7')} title="Team games in the next 7 days">
                  Next 7
                </SortTh>
              )}
              {showNext7 && (
                <SortTh right active={sortKey === 'games_this_week'} dir={sortDir} onClick={() => sortBy('games_this_week')} title="Team games left this fantasy week (Monday to Sunday)">
                  Wk
                </SortTh>
              )}
              {categoryColumns.map((c) => {
                const isPunted = !!c.category && punted.has(c.category);
                return (
                  <SortTh key={c.key} right active={sortKey === c.key} dir={sortDir} onClick={() => sortBy(c.key, c.label === 'TO' && c.kind !== 'z' ? 'asc' : 'desc')}>
                    {isPunted ? (
                      <s>{c.label}</s>
                    ) : c.category && setup.focus.includes(c.category) && !points ? (
                      <span className="text-accent" title={`Focus: counts ${FOCUS_WEIGHT}× in value and Fit`} data-testid="focus-head">
                        {c.label}
                      </span>
                    ) : (
                      c.label
                    )}
                  </SortTh>
                );
              })}
              {showFit && (
                <SortTh
                  right
                  active={sortKey === 'fit'}
                  dir={sortDir}
                  onClick={() => sortBy('fit')}
                  title={
                    weekMatch
                      ? `Value with each category weighted by how close it is against ${setup.names[setup.opponent ?? 0]} this week (1.5 for the closest third, 1 the middle, 0.5 the blowouts either way)`
                      : standings
                        ? "Value with each category weighted by how much a gain there raises your chance of beating the league's other teams in it: close categories count most, ones won or lost against everyone by a wide margin least"
                        : 'Value with each category weighted by where your team is weak (1.5 for the weakest third, 1 the middle, 0.5 the strongest)'
                  }
                >
                  Fit
                </SortTh>
              )}
              {showMarket && (
                <SortTh
                  right
                  active={sortKey === 'market_rank'}
                  dir={sortDir}
                  onClick={() => sortBy('market_rank', 'asc')}
                  title="Where ESPN fantasy drafters take the player (by average draft position); the tooltip says how widely ESPN leagues roster the player"
                >
                  Mkt
                </SortTh>
              )}
              {showMarket && (
                <SortTh
                  right
                  active={sortKey === 'market_gap'}
                  dir={sortDir}
                  onClick={() => sortBy('market_gap')}
                  title="Market rank minus the player's rank on this board with your league's settings: positive when drafters take the player later than the value here (a bargain), negative when they reach"
                >
                  vs Mkt
                </SortTh>
              )}
              {!isLine(view) && (
                <SortTh right active={sortKey === 'value'} dir={sortDir} onClick={() => sortBy('value')}>
                  Total
                </SortTh>
              )}
              <Th>Cmp</Th>
            </tr>
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
      {showTiers && (
        <p className="text-xs text-muted" data-testid="tier-note">
          Tiers split the {pool} players a league of {setup.teams} teams × {setup.rosterSpots} rosters into {tiers.list.length} groups where their
          values naturally separate (Jenks natural breaks), about one per round. Players in a tier are close in value, so when a tier is nearly gone,
          take its last player before the drop to the next.
        </p>
      )}
      {ranked.length > shown && (
        <button
          type="button"
          onClick={() => setShown(shown + PAGE)}
          className="justify-self-start rounded border border-line px-3 py-1 text-sm hover:bg-card"
          data-testid="board-more"
        >
          Show {Math.min(PAGE, ranked.length - shown)} more
        </button>
      )}
    </div>
  );
}
