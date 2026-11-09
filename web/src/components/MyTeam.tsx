import { useCallback, useEffect, useMemo, useState } from 'react';

import { fetchBuildJson, fetchCurrentJson, fetchPageRows, type League } from '../lib/data';
import { CATEGORIES, CATEGORY_LABELS, fmt, ordinal } from '../lib/format';
import { currentLeague } from '../lib/league';
import { href } from '../lib/site';
import { assign, categoryWeights, owners, toggleIl, useLeague } from '../lib/fantasy-league';
import { scaleValue } from '../lib/league-value';
import { acceptable, type FairnessModel, leagueState, marketMap, playerWorth } from '../lib/league-model';
import { type BuildPlan, buildPlan } from '../lib/build-plan';
import { leagueStandings as tradeStandings } from '../lib/trade-impact';
import { dropRule, type RosterReview, type Upgrade } from '../lib/roster-upgrades';
import { teamReview } from '../lib/team-review';
import { leagueValues } from '../lib/valuation';
import { streamMove, streamTargets } from '../lib/matchup-streams';
import { tonight } from '../lib/game-state';
import { liveWeek, matchup, usableScore, type WeekMatchup, type WeekTotals, weekTotals } from '../lib/matchup';
import { expectedWins, leagueStandings, type LeagueStandings, powerRankings } from '../lib/standings';
import { leagueRecords, recordsFromText } from '../lib/league-state';
import { standingsOf } from '../lib/records';
import { hasWeekGames, type ValueUnit } from '../lib/week-value';
import { ilMoves, ilMovesByListing } from '../lib/il-moves';
import { minutesByPlayer, minutesGoTo, type MinutesRow } from '../lib/minutes-go-to';
import { daysLeftInWeek, type Slot, SLOT_KEYS, SLOT_LABEL, slotList, startsByPlayer, weekPlan, type WeekPlan } from '../lib/lineup';
import { easternDate, gamesToCome, sitsOut, type TodayGame, todayGroups, todayVerdict } from '../lib/today';
import type { ModelRow } from '../lib/board-model';
import { CategoryProfile, LeagueBar, Today, type TodayRow, Upgrades } from './LeagueParts';
import { Matchup, type MatchupBasis } from './MatchupCard';
import { BuildYourTeam } from './BuildYourTeam';
import { LeagueTable } from './PowerTable';
import { Standings } from './Standings';
import { IlMoves } from './IlMoves';
import { MinutesGoTo } from './MinutesGoTo';
import { PlayoffPlan } from './PlayoffPlan';
import type { TeamWeek } from '../lib/playoff-weeks';
import { PlayerNoteLine } from './PlayerNoteLine';
import { usePlayerNotes } from '../lib/player-notes';
import { SHOWS } from '../lib/visibility';
import { SyncLine, useEspnSync } from './LeagueSync';
import { staleOpponent, weekScore } from '../lib/league-sync';
import { InjuryTag, injuryDetail, Loading, Problem, Signed, Td, Th, Tile } from './ui';

interface TeamRow extends ModelRow {
  full_name: string | null;
  team_abbreviation: string | null;
  team_id?: string | null;
  rank_total: number;
  market_rank?: number | null;
  availability_multiplier: number | null;
  games_remaining: number | null;
  games_this_week?: number | null;
  injury_status: string | null;
  injury_group: string | null;
  injury_type: string | null;
  expected_return: string | null;
  injury_note: string | null;
  expected_games_missed: number | null;
  lineup_role?: string | null;
  lineup_confirmed?: boolean | null;
  lineup_date?: string | null;
  news_flag?: string | null;
}

const NONE: string[] = [];

/**
 * Each kept category against the league (#662): the chance of beating an average rival, and the
 * team's place among the teams with rosters in. Replaces the board's "Weakest" and the League
 * page's category bars with what the standings model says the manager is likely to win.
 */
function Categories({
  standings,
  mine,
  cats,
  punted,
  h2h,
  totals,
}: {
  standings: LeagueStandings | null;
  mine: number;
  cats: string[];
  punted: string[];
  h2h: boolean;
  totals: Record<string, number> | null;
}) {
  const label = (c: string) => CATEGORY_LABELS[c] ?? c;
  const puntLine = punted.length > 0 && (
    <p className="mt-2 text-xs text-muted">
      Punted: {punted.map(label).join(', ')}. They count for nothing in your values and suggestions.
    </p>
  );
  if (!standings) {
    return (
      <Tile title="Your categories" id="cats" testid="my-categories" issue={h2h ? undefined : 898}>
        <p className="mt-1 text-sm text-muted" data-testid="cats-summary">
          Your team&apos;s value above replacement in each category. Add the other teams&apos; rosters on the{' '}
          <a href={href('/league/')} className="underline underline-offset-4">
            League page
          </a>{' '}
          to see your chance of beating them, category by category.
        </p>
        {totals && (
          <div className="mt-2">
            <CategoryProfile totals={totals} weakest={Object.entries(totals).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([c]) => c)} />
          </div>
        )}
        {puntLine}
      </Tile>
    );
  }
  // the manager's place in a category: 1 + the rivals whose total beats theirs
  const place = (c: string) => 1 + standings.others.filter((t) => (standings.totals[t]?.[c] ?? 0) > (standings.totals[mine]?.[c] ?? 0)).length;
  const wins = expectedWins(standings.chances);
  const order = cats.filter((c) => c in standings.chances);
  return (
    <Tile title="Your categories" id="cats" testid="my-categories" issue={h2h ? undefined : 898}>
      <p className="mt-1 text-sm" data-testid="cats-summary">
        {h2h ? (
          <>
            Against an average rival you project to win{' '}
            <strong>
              {fmt(wins, 1)} of {order.length} categories
            </strong>{' '}
            a week.
          </>
        ) : (
          <>
            You project to finish ahead of an average rival in{' '}
            <strong>
              {fmt(wins, 1)} of {order.length} categories
            </strong>
            .
          </>
        )}{' '}
        <span className="text-muted">Strengths to trade from are green; the categories a move should target are red.</span>
      </p>
      <ul className="mt-2 grid max-w-2xl gap-1 text-sm" data-testid="cat-chances">
        {order.map((c) => {
          const p = standings.chances[c] ?? 0.5;
          const tone = p >= 0.6 ? 'bg-good' : p <= 0.4 ? 'bg-bad' : 'bg-muted';
          const text = p >= 0.6 ? 'text-good' : p <= 0.4 ? 'text-bad' : 'text-muted';
          return (
            <li key={c} className="grid grid-cols-[3rem_minmax(0,1fr)_3rem_5.5rem] items-center gap-2" data-testid="cat-chance" data-cat={c}>
              <span className="font-medium">{label(c)}</span>
              <span className="h-2 overflow-hidden rounded bg-bg" aria-hidden="true">
                <span className={`block h-full ${tone}`} style={{ width: `${Math.round(p * 100)}%` }} />
              </span>
              <span className={`text-right tabular-nums ${text}`} title={`Chance of beating an average rival in ${label(c)}`}>
                {Math.round(p * 100)}%
              </span>
              <span className="text-xs text-muted">
                {ordinal(place(c))} of {standings.others.length + 1}
              </span>
            </li>
          );
        })}
      </ul>
      {puntLine}
    </Tile>
  );
}

const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const dayName = (iso: string) => DAY.format(new Date(`${iso}T12:00:00Z`));
/** Open slots counted by kind, "3 G · 2 C · 2 Util": short enough for a phone's column. */
const openText = (open: Slot[]) =>
  SLOT_KEYS.map((k) => [k, open.filter((s) => s === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${SLOT_LABEL[k]}`)
    .join(' · ');

/**
 * The week's lineup (#735): day by day, who starts under the league's slots, who sits because the
 * lineup is full, and the slots left open to stream into; and the games each side can start.
 */
function LineupTile({
  plan,
  theirs,
  opponent,
  nameOf,
  league,
}: {
  plan: WeekPlan;
  theirs: WeekPlan | null;
  opponent: string | null;
  nameOf: (id: string) => string;
  league: League;
}) {
  const openDays = plan.days.filter((d) => d.open.length > 0).map((d) => d.date);
  const pickups = href(`/streamers/?league=${league}&window=week&open=${openDays.join(',')}`);
  return (
    <Tile title="This week's lineup" id="lineup" testid="lineup-plan" issue={759}>
      <p className="mt-1 text-sm" data-testid="lineup-summary">
        You can start <strong>{plan.started} games</strong> over the {plan.days.length} {plan.days.length === 1 ? 'day' : 'days'} left
        {theirs && opponent ? (
          <>
            , against {opponent}&apos;s <strong>{theirs.started}</strong>
          </>
        ) : null}
        .{' '}
        {plan.lost > 0 ? (
          <span className="text-warn">{plan.lost} lost to a full lineup.</span>
        ) : (
          <span className="text-muted">No game lost to a full lineup.</span>
        )}{' '}
        {plan.openSlots > 0 && (
          <>
            {plan.openSlots} open {plan.openSlots === 1 ? 'slot' : 'slots'} to stream into:{' '}
            <a href={pickups} className="font-medium text-accent underline-offset-4 hover:underline" data-testid="lineup-pickups">
              pickups for those days →
            </a>
          </>
        )}
      </p>
      <div className="table-scroll mt-2 overflow-auto" tabIndex={0} role="region" aria-label="This week's lineup, day by day">
        <table className="w-full text-sm" data-testid="lineup-days">
          <thead>
            <tr>
              <Th>Day</Th>
              <Th right>Start</Th>
              <Th>Open</Th>
              <Th>Sits (lineup full)</Th>
            </tr>
          </thead>
          <tbody>
            {plan.days.map((d) => (
              <tr key={d.date} className="border-t border-line" data-date={d.date}>
                <Td>{dayName(d.date)}</Td>
                <Td right>{d.started.size}</Td>
                <Td>
                  <span className={d.open.length ? '' : 'text-muted'} data-testid="open-slots">
                    {d.open.length ? openText(d.open) : '–'}
                  </span>
                </Td>
                <Td>
                  <span className={d.benched.length ? 'text-warn' : 'text-muted'}>{d.benched.length ? d.benched.map(nameOf).join(', ') : '–'}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        Each day starts your most valuable players with a game that the slots can hold, moving a player with two positions to make room; a player
        listed out or doubtful sits. Positions are G, F and C: PG and SG count as G, SF and PF as F.
      </p>
    </Tile>
  );
}

export default function MyTeam() {
  const [league] = useState<League>(() => currentLeague());
  const [rows, setRows] = useState<TeamRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [games, setGames] = useState<TodayGame[] | null>(null);
  const [minutes, setMinutes] = useState<Map<string, MinutesRow[]>>(() => new Map());
  const [teamWeeks, setTeamWeeks] = useState<TeamWeek[] | null>(null);
  const [setup, updateLeague] = useLeague(league);
  // an ESPN league is read again on a visit, so the rosters and this week's opponent are current (#815)
  const sync = useEspnSync(setup, updateLeague, rows);
  // a one-line note under each flagged player, when the day's notes are out (#823)
  const notes = usePlayerNotes(league);

  useEffect(() => {
    let live = true;
    fetchPageRows<TeamRow>(`board/${league}`)
      .then((data) => live && setRows(data))
      .catch((e: unknown) => live && setError(e));
    fetchBuildJson<TodayGame[]>(`schedule/${league}.json`)
      .then((g) => live && setGames(g))
      .catch(() => live && setGames(null));
    // an older build without the file names nobody (#820)
    fetchCurrentJson<MinutesRow[]>(`minutes/${league}.json`)
      .then((m) => live && setMinutes(minutesByPlayer(m)))
      .catch(() => live && setMinutes(new Map()));
    // the rest of the season's games per team and week, for the playoff weeks (#821)
    fetchCurrentJson<TeamWeek[]>(`team_weeks/${league}.json`)
      .then((w) => live && setTeamWeeks(w))
      .catch(() => live && setTeamWeeks(null));
    return () => {
      live = false;
    };
  }, [league]);

  const owner = useMemo(() => owners(setup), [setup]);
  const points = setup.scoring === 'points';
  const h2h = setup.format === 'h2h';
  const punted = useMemo(() => (setup.scoring === 'cats8' ? [...setup.punts, 'z_turnovers'] : setup.punts), [setup.punts, setup.scoring]);
  const activeCats = useMemo(() => CATEGORIES.filter((c) => !punted.includes(c)), [punted]);
  // every category the league scores: a punted one still counts in the week's record (it is
  // conceded, not dropped), only an eight-category league leaves turnovers out
  const scoredCats = useMemo(() => CATEGORIES.filter((c) => !(setup.scoring === 'cats8' && c === 'z_turnovers')), [setup.scoring]);
  const byId = useMemo(() => new Map((rows ?? []).map((r) => [r.player_id, r])), [rows]);
  const roster = useMemo(() => setup.rosters[setup.mine] ?? [], [setup.rosters, setup.mine]);
  const myTeam = useMemo(
    () => roster.filter((id) => !setup.il.includes(id)).map((id) => byId.get(id)).filter((r): r is TeamRow => !!r),
    [roster, setup.il, byId],
  );
  const remaining = useMemo(() => (rows ?? []).reduce((m, r) => Math.max(m, r.games_remaining ?? 0), 0), [rows]);

  // the league's values, shared with Pickups' top adds (#819): category or point values, the
  // rest-of-season value, and last-ten form for the week unit (#466)
  const values = useMemo(
    () => leagueValues(rows ?? [], { scoring: setup.scoring, punts: setup.punts, weights: setup.weights, teams: setup.teams, rosterSpots: setup.rosterSpots }),
    [rows, setup.scoring, setup.punts, setup.weights, setup.teams, setup.rosterSpots],
  );
  const { restValue, perGame } = values;
  const leagueCats = rows ? values.leagueCats : null;
  const leaguePoints = rows ? values.leaguePoints : null;

  const standings = useMemo(() => {
    if (!rows || !leagueCats || myTeam.length === 0) return null;
    return leagueStandings(league, setup, activeCats, (id) => leagueCats.get(id), (id) => byId.get(id)?.availability_multiplier ?? 1, remaining);
  }, [rows, leagueCats, myTeam.length, league, setup, activeCats, byId, remaining]);
  // power rankings (#743): every team with half a roster, by what the standings model projects
  const power = useMemo(
    () =>
      rows && leagueCats
        ? powerRankings(league, setup, activeCats, (id) => leagueCats.get(id), (id) => byId.get(id)?.availability_multiplier ?? 1, remaining)
        : null,
    [rows, leagueCats, league, setup, activeCats, byId, remaining],
  );
  const myTotals = useMemo(
    () => (leagueCats && myTeam.length ? Object.fromEntries(activeCats.map((c) => [c, myTeam.reduce((s, r) => s + (leagueCats.get(r.player_id)?.[c] ?? 0), 0)])) : null),
    [leagueCats, myTeam, activeCats],
  );

  // the week unit for the moves, and this week's matchup
  const weekAvailable = useMemo(() => !!rows && hasWeekGames(rows), [rows]);
  const [unit, setUnit] = useState<ValueUnit>(h2h ? 'week' : 'rest');
  const week = unit === 'week' && weekAvailable;

  // each team's games still to tip off this fantasy week, on the page's one clock (#927): the
  // roster's "games this week", which the build froze at its own time before
  const teamGamesLeft = useMemo(() => {
    if (!games) return null;
    const week = daysLeftInWeek(easternDate());
    const left = new Map<string, number>();
    for (const g of gamesToCome(games, Date.now())) {
      if (!week.includes(g.game_date)) continue;
      for (const t of [g.home_team_id, g.away_team_id]) left.set(t, (left.get(t) ?? 0) + 1);
    }
    return left;
  }, [games]);

  // this week's opponent: one a Yahoo import set last week no longer holds (#927)
  const opponent = useMemo(
    () => (staleOpponent(setup, easternDate(), (ms) => easternDate(new Date(ms))) ? null : setup.opponent),
    [setup],
  );

  // the week's lineup (#735): the days left from a moment, who plays each, and the slots they fill
  const planFrom = useMemo(() => {
    if (!games || !rows || myTeam.length === 0) return null;
    return (since: number) => {
      // one clock (#927): only games still to tip off at `since`, and only the days that have one,
      // so a day with no games is never an open slot and a game under way is no longer a start
      const toCome = gamesToCome(games, since);
      const week = daysLeftInWeek(easternDate(new Date(since)));
      const playing = new Map<string, Set<string>>();
      for (const g of toCome) {
        if (!week.includes(g.game_date)) continue;
        for (const t of [g.home_team_id, g.away_team_id]) playing.set(`${g.game_date}|${t}`, new Set());
      }
      if (playing.size === 0) return null;
      const dates = week.filter((d) => toCome.some((g) => g.game_date === d));
      const plays = (id: string, date: string) => {
        const r = byId.get(id);
        // out, doubtful, or inactive on the team's lineup that day (#878): no start
        return !!r && !sitsOut(r, date) && playing.has(`${date}|${r.team_id}`);
      };
      const slots = slotList(setup.lineup);
      const plan = (team: TeamRow[]) => weekPlan(team.map((r) => ({ id: r.player_id, position: r.position, value: perGame(r.player_id) })), dates, plays, slots);
      const theirs = !h2h || opponent === null ? null : rows.filter((r) => owner.get(r.player_id) === opponent && !setup.il.includes(r.player_id));
      return { mine: plan(myTeam), theirs: theirs && theirs.length ? plan(theirs) : null };
    };
  }, [games, rows, myTeam, byId, setup.lineup, opponent, setup.il, owner, perGame, h2h]);
  // the lineup from now: Today's and the lineup tile's
  const lineupPlans = useMemo(() => planFrom?.(Date.now()) ?? null, [planFrom]);
  // The week's matchup: each side's projected totals over the games its lineup will start (#817),
  // from the lineup plans above, so benched and out players' games no longer count. An ESPN
  // league read today starts from the score so far: by category, or in fantasy points (#877).
  const weekMatch = useMemo<{ match: WeekMatchup; basis: MatchupBasis } | null>(() => {
    if (!h2h || opponent === null || !weekAvailable || myTeam.length === 0 || !rows) return null;
    const theirs = rows.filter((r) => owner.get(r.player_id) === opponent && !setup.il.includes(r.player_id));
    const scoring = points ? setup.weights : undefined;
    const today = easternDate();
    const score = usableScore(weekScore(setup, today, (ms) => easternDate(new Date(ms))), points);
    // the score so far already holds today's games that had tipped when it was read (#875)
    const source = setup.source;
    const read = typeof score === 'string' || !source ? null : tonight(games ?? [], today, source.games, source.syncedAt);
    const toCome = (id: string, date: string) => (read && date === today ? (read.left.get(byId.get(id)?.team_id ?? '') ?? 1) : 1);
    // with a score so far, the rest of the week runs from the moment it was read, so the games
    // played since (a Yahoo import from earlier in the week) are projected, not lost (#927)
    const plans = read && source ? (planFrom?.(source.syncedAt) ?? null) : lineupPlans;
    const counted = (plan: WeekPlan | null | undefined) => {
      if (!plan) return undefined;
      const starts = startsByPlayer(plan, toCome);
      return (r: Record<string, unknown>) => starts.get(String(r['player_id'])) ?? 0;
    };
    const rest = {
      mine: weekTotals(myTeam, scoredCats, scoring, counted(plans?.mine)),
      theirs: weekTotals(theirs, scoredCats, scoring, counted(plans?.theirs)),
    };
    const cats = points ? [] : scoredCats;
    // no "too close" band while its fit is unjudged (ADR 0026): each category reads won or lost
    const closeness = SHOWS.tooClose ? undefined : 0;
    const week = (mine: WeekTotals, theirs: WeekTotals) => matchup(league, cats, mine, theirs, closeness, points ? [] : activeCats);
    if (typeof score === 'string' || !read) return { match: week(rest.mine, rest.theirs), basis: { live: false, reason: typeof score === 'string' ? score : 'not-espn' } };
    const live = liveWeek(cats, score, rest);
    return { match: week(live.mine, live.theirs), basis: { live: true, projectedOnly: live.projectedOnly, read } };
  }, [h2h, setup, opponent, weekAvailable, myTeam, rows, owner, points, activeCats, scoredCats, lineupPlans, planFrom, games, byId, league]);
  // Today's start and sit (#816): the best lineup the slots hold from today's players, by the same
  // per-game values the week's plan uses.
  const verdict = useMemo(() => {
    if (!games || !myTeam.length) return null;
    // today's games still to tip off: once tonight's have started there is no start to make (#927)
    const groups = todayGroups(myTeam as unknown as TodayRow[], gamesToCome(games, Date.now()), easternDate());
    if (!groups.leagueGames) return null;
    return todayVerdict(groups, slotList(setup.lineup), perGame, (id) => byId.get(id)?.position);
  }, [games, myTeam, setup.lineup, perGame, byId]);

  // the roster review, as Pickups' top adds read it (#819); the week's drives the stream line (#818)
  const weekReview = useMemo(() => (rows && weekAvailable ? teamReview(league, rows, setup, values, true) : null), [league, rows, setup, values, weekAvailable]);
  // the rest of the season's review: the Moves' unit by default, and the drops for the playoff targets (#821)
  const restReview = useMemo(() => (rows ? teamReview(league, rows, setup, values, false) : null), [league, rows, setup, values]);
  const review = useMemo<RosterReview | null>(() => (week ? (weekReview?.review ?? null) : (restReview?.review ?? null)), [week, weekReview, restReview]);
  // From the matchup to the stream that flips a category (#818): the close and losing categories,
  // and the top add for them on the open days, with the drop the week's review names.
  const targets = useMemo(() => (weekMatch && !points ? streamTargets(weekMatch.match) : []), [weekMatch, points]);
  const stream = useMemo(() => {
    if (!weekMatch || points || !lineupPlans || !games || !rows) return null;
    const days = lineupPlans.mine.days.map((d) => d.date);
    const open = lineupPlans.mine.days.filter((d) => d.open.length > 0).map((d) => d.date);
    const playing = new Set(games.filter((g) => days.includes(g.game_date)).flatMap((g) => [`${g.game_date}|${g.home_team_id}`, `${g.game_date}|${g.away_team_id}`]));
    const starts = startsByPlayer(lineupPlans.mine);
    return streamMove({
      match: weekMatch.match,
      rows,
      available: (id) => !owner.has(id),
      games: (r) => ({ window: days.filter((d) => playing.has(`${d}|${r.team_id}`)).length, open: open.filter((d) => playing.has(`${d}|${r.team_id}`)).length }),
      openDays: open.length,
      kept: activeCats,
      drops: weekReview?.drops ?? [],
      roster: weekReview?.mine ?? [],
      position: (id) => byId.get(id)?.position,
      starts: (id) => starts.get(id) ?? 0,
    });
  }, [weekMatch, points, lineupPlans, games, rows, owner, activeCats, weekReview, byId]);
  // stable for the playoff plan, whose odds play 2,000 seasons only when an input changes (#821)
  const catOf = useMemo(() => (leagueCats ? (id: string) => leagueCats.get(id) : null), [leagueCats]);
  const fptsOf = useMemo(() => (points && leaguePoints ? (id: string) => leaguePoints.get(id)?.fpts ?? 0 : null), [points, leaguePoints]);
  const owned = useCallback((id: string) => owner.has(id), [owner]);
  const applyUpgrade = useCallback((u: Upgrade) => updateLeague((s) => assign(assign(s, u.drop, null), u.add, s.mine)), [updateLeague]);

  // Build your team (#809): the league as the Trade page models it, for the rest of the season,
  // and the plan read from it. A categories league only; a draft under way waits.
  const catWeight = useMemo(() => categoryWeights(setup), [setup]);
  const worth = useMemo(
    () => playerWorth(rows ?? [], { points, cats: activeCats, catWeight, catValues: leagueCats, pointValues: leaguePoints, recentCats: null }),
    [rows, points, activeCats, catWeight, leagueCats, leaguePoints],
  );
  const plan = useMemo<BuildPlan | null>(() => {
    if (!rows || points || myTeam.length === 0 || setup.drafting) return null;
    const state = leagueState(rows, {
      league,
      format: setup.format,
      points,
      cats: activeCats,
      rosters: setup.rosters,
      il: setup.il,
      rosterSpots: setup.rosterSpots,
      owner,
      worth,
      week: false,
    });
    const standings = state ? tradeStandings(state, setup.mine) : null;
    const rest = (id: string) => worth.get(id)?.rest ?? 0;
    const fairness: FairnessModel = {
      state,
      mine: setup.mine,
      value: rest,
      market: marketMap(rows, worth),
      ranked: (id) => typeof byId.get(id)?.market_rank === 'number',
    };
    const mine = myTeam.map((r) => r.player_id);
    return buildPlan({
      cats: activeCats,
      // the league's punts; an 8-category league's turnovers are not a punt, just not counted
      punted: setup.punts,
      mine: setup.mine,
      roster: mine,
      others: rows.filter((r) => !mine.includes(r.player_id) && !setup.il.includes(r.player_id)).map((r) => r.player_id),
      owner: (id) => owner.get(id),
      rest,
      catValue: (id) => worth.get(id)?.cats,
      scale: (id, perGame) => scaleValue(perGame, byId.get(id) ?? {}),
      position: (id) => byId.get(id)?.position,
      droppable: dropRule(rows, mine, { league, teams: setup.teams, rosterSpots: setup.rosterSpots }, restValue, false),
      model: state && standings ? { state, standings, acceptable: (partner, give, get) => acceptable(fairness, partner, give, get) } : null,
    });
  }, [rows, points, myTeam, setup, league, activeCats, owner, worth, byId, restValue]);

  if (error) return <Problem error={error} />;
  if (!rows) return <Loading what="your team" />;

  if (roster.length === 0) {
    return (
      <div className="grid gap-3" data-testid="team-empty">
        <SyncLine setup={setup} sync={sync} />
        <LeagueBar setup={setup} rostered={owner.size} myCount={0} weakest={[]} />
        <p className="rounded-lg border border-line bg-card p-3 text-sm">
          Your team is empty. Set up your league on the{' '}
          <a href={href('/league/')} className="font-medium text-accent underline-offset-4 hover:underline">
            League page
          </a>
          : import it from Yahoo, paste each roster, or draft there pick by pick. This page then shows your week, your categories against the league,
          your roster and the moves worth making.
        </p>
      </div>
    );
  }

  // the report's listing until the games-missed estimate is judged (#763, #770)
  const moves = SHOWS.injuryEstimate ? ilMoves(rows, roster, setup.il) : ilMovesByListing(rows, roster, setup.il);
  // Today's card shows on a game day (a verdict needs one) when no draft is under way
  const todayShown = !!verdict && !setup.drafting;
  const showMatchup = h2h && owner.size > 0 && !setup.drafting && weekAvailable;
  // a player headed for the IL is an IL move, not a trade chip
  const shown = review && { ...review, chips: review.chips.filter((id) => !moves.toIl.includes(id)) };
  const name = (id: string) => byId.get(id)?.full_name ?? id;
  const link = (id: string) => (
    <a href={href(`/p/${league}/${id}/`)} className="underline-offset-4 hover:underline">
      {name(id)}
    </a>
  );
  const sorted = [...roster].sort((a, b) => {
    const il = Number(setup.il.includes(a)) - Number(setup.il.includes(b));
    return il || (restValue.get(b) ?? 0) - (restValue.get(a) ?? 0);
  });
  // the real standings lead the page (#822): ESPN's or Yahoo's records, or those entered by hand (#874);
  // the projected power table goes one click down
  const recorded = leagueRecords(setup);
  const real = recorded ? standingsOf(recorded.records) : null;
  const powerTable = (
    <LeagueTable
      names={setup.names}
      mine={setup.mine}
      rosters={setup.rosters}
      il={setup.il}
      cats={points ? [] : activeCats}
      catValue={leagueCats ? (id) => leagueCats.get(id) : null}
      fpts={fptsOf}
      power={power}
      inline={!!real}
      note={real ? null : "Import the league from ESPN, run the Yahoo bookmark, or enter each team's record on the League page to show the real standings."}
    />
  );
  // who takes an out player's minutes, and the pickup that goes with it (#820)
  const minutesLine = (id: string, onAdd?: (add: string) => void) => {
    const call = minutesGoTo(minutes.get(id), byId.get(id)?.team_id, owner);
    if (!call) return null;
    const teamName = (t: number) => setup.names[t] ?? `Team ${t + 1}`;
    return <MinutesGoTo call={call} player={name(id)} league={league} mine={setup.mine} teamName={teamName} onAdd={onAdd} />;
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <SyncLine setup={setup} sync={sync} />
      <LeagueBar setup={setup} rostered={owner.size} myCount={myTeam.length} weakest={[]} />
      {setup.drafting && (
        <p className="rounded-lg border border-accent bg-card p-3 text-sm" data-testid="team-drafting">
          Your draft is under way on the{' '}
          <a href={href('/league/')} className="underline underline-offset-4">
            League page
          </a>
          ; moves wait until it ends.
        </p>
      )}
      {/* the playoff push leads a head-to-head league (#821): the odds, the playoff weeks' games and the target */}
      {SHOWS.playoffs && h2h && teamWeeks && !setup.drafting && (
        <PlayoffPlan
          league={league}
          setup={setup}
          rows={rows}
          teamWeeks={teamWeeks}
          cats={activeCats}
          catValue={catOf}
          fpts={fptsOf}
          perGame={perGame}
          owned={owned}
          drops={restReview?.drops ?? NONE}
          roster={restReview?.mine ?? NONE}
          today={easternDate()}
        />
      )}

      {games && myTeam.length > 0 && !setup.drafting && (
        <Today
          league={league}
          players={myTeam as unknown as TodayRow[]}
          games={games}
          date={easternDate()}
          verdict={verdict}
          need={SHOWS.streams ? targets : []}
          minutesFor={SHOWS.minutes ? minutesLine : undefined}
          notes={SHOWS.notes ? notes : null}
        />
      )}

      {/* the week beside the season: this week's categories next to the league-wide chances */}
      <div className={`grid items-start gap-3 ${showMatchup && !points && SHOWS.categories ? 'lg:grid-cols-2' : ''}`}>
        {showMatchup && (
          <Matchup
            setup={setup}
            match={weekMatch?.match ?? null}
            basis={weekMatch?.basis ?? null}
            points={points}
            league={league}
            openDays={SHOWS.streams ? (lineupPlans?.mine.days.filter((d) => d.open.length > 0).map((d) => d.date) ?? []) : []}
            stream={SHOWS.streams ? stream : null}
            nameOf={name}
            onOpponent={(t) => updateLeague((s) => ({ ...s, opponent: t }))}
          />
        )}
        {SHOWS.categories && !points && <Categories standings={standings} mine={setup.mine} cats={activeCats} punted={punted} h2h={h2h} totals={myTotals} />}
      </div>

      {SHOWS.lineup && lineupPlans && !setup.drafting && (
        <LineupTile
          plan={lineupPlans.mine}
          theirs={lineupPlans.theirs}
          opponent={setup.opponent === null ? null : (setup.names[setup.opponent] ?? null)}
          nameOf={name}
          league={league}
        />
      )}

      <Tile title="Roster" id="roster" testid="my-roster">
        <IlMoves
          moves={moves}
          link={link}
          missed={(id) => byId.get(id)?.expected_games_missed ?? 0}
          back={(id) => byId.get(id)?.expected_return}
          // each IL move with the pickup for the spot it opens (#820)
          minutes={(id) => (SHOWS.minutes ? minutesLine(id, (add) => updateLeague((s) => assign(toggleIl(s, id), add, s.mine))) : null)}
          onToggle={(id) => updateLeague((s) => toggleIl(s, id))}
        />
        <div className="table-scroll mt-2 overflow-auto" tabIndex={0} role="region" aria-label="Your roster">
          <table className="w-full text-sm" data-testid="roster-table">
            <thead>
              <tr>
                <Th>Player</Th>
                <Th right>
                  <span title="Value above replacement over the games each player is expected to play from today">Rest of season</span>
                </Th>
                <Th right>
                  <span title="Value per game above replacement, from the projected line">Per game</span>
                </Th>
                {!points && (
                  <Th right>
                    <span title="Value per game above replacement over the last ten games">Last 10</span>
                  </Th>
                )}
                {weekAvailable && (
                  <Th right>
                    <span title="Team games left this fantasy week (Monday to Sunday)">Games this week</span>
                  </Th>
                )}
              </tr>
            </thead>
            <tbody>
              {sorted.map((id) => {
                const r = byId.get(id);
                const onIl = setup.il.includes(id);
                const pg = perGame(id);
                const recent = perGame(id, true);
                const form = recent - pg;
                return (
                  <tr key={id} className={`border-t border-line ${onIl ? 'text-muted' : ''}`} data-player={id}>
                    <Td>
                      <span className="flex flex-wrap items-center gap-1">
                        {link(id)}
                        <span className="text-xs text-muted">{[r?.position, r?.team_abbreviation].filter(Boolean).join(' · ')}</span>
                        {onIl && <span className="rounded border border-line px-1 text-[10px]">IL</span>}
                        {r && <InjuryTag group={r.injury_group} status={r.injury_status} detail={injuryDetail(r)} />}
                        {/* the line sits in Today's card on a game day, here otherwise (#823) */}
                        {SHOWS.notes && r && !onIl && !todayShown && <PlayerNoteLine notes={notes} row={r} />}
                      </span>
                    </Td>
                    <Td right>
                      <strong>{fmt(restValue.get(id) ?? null, 1)}</strong>
                    </Td>
                    <Td right>
                      <Signed value={r ? pg : null} digits={1} />
                    </Td>
                    {!points && (
                      <Td right>
                        <span
                          className={form >= 1 ? 'text-good' : form <= -1 ? 'text-bad' : ''}
                          title={form >= 1 ? 'Playing above the projection' : form <= -1 ? 'Playing below the projection' : undefined}
                          data-testid="form"
                        >
                          <Signed value={r ? recent : null} digits={1} />
                          {form >= 1 ? ' ▲' : form <= -1 ? ' ▼' : ''}
                        </span>
                      </Td>
                    )}
                    {weekAvailable && <Td right>{onIl ? '–' : teamGamesLeft ? (teamGamesLeft.get(r?.team_id ?? '') ?? 0) : (r?.games_this_week ?? 0)}</Td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Tile>

      {/* the standings, after the moves to make: where the team stands, not what to do today */}
      {real && <Standings table={real} mine={setup.mine} names={setup.names} power={SHOWS.power ? powerTable : null} from={recordsFromText(recorded?.from ?? 'entered')} />}

      {SHOWS.swaps && shown && (
        <Upgrades
          league={league}
          review={shown}
          nameOf={name}
          detailOf={(id) => [byId.get(id)?.position, byId.get(id)?.team_abbreviation].filter(Boolean).join(', ')}
          onApply={applyUpgrade}
          unit={week ? 'week' : 'rest'}
          onUnit={weekAvailable ? setUnit : null}
          gamesOf={(id) => byId.get(id)?.games_this_week ?? 0}
        />
      )}

      {SHOWS.build && plan && (
        <BuildYourTeam
          plan={plan}
          league={league}
          nameOf={name}
          detailOf={(id) => [byId.get(id)?.position, byId.get(id)?.team_abbreviation].filter(Boolean).join(' ')}
          teamName={(t) => setup.names[t] ?? `Team ${t + 1}`}
          h2h={h2h}
        />
      )}

      {SHOWS.power && !real && powerTable}
    </div>
  );
}
