/**
 * The Trade page: what each side of a trade is worth under the manager's league settings, how the
 * manager's team changes category by category, and a verdict. Players come from the league's
 * rosters when the League page has them, or from a search over the whole board.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { fetchBuildJson, type League } from '../lib/data';
import { CATEGORY_LABELS, fmt, pct } from '../lib/format';
import { currentLeague } from '../lib/league';
import { categoryWeights, DEFAULT_SETTINGS, isDefaultSettings, keptCategories, owners, useLeague, weightedSum } from '../lib/fantasy-league';
import { categoryValues, marketPriorShift, pointValues, scaleValue } from '../lib/league-value';
import { acceptable, type FairnessModel, leagueState, marketMap, playerWorth, tradeLenses, type Worth } from '../lib/league-model';
import { href } from '../lib/site';
import { matchup, weekTotals } from '../lib/matchup';
import { type LeagueState, leagueStandings, meaningful, objective, rostersAfter, teamNeeds, tradeImpact } from '../lib/trade-impact';
import { median, ranks, tradeChips, tradeTargets } from '../lib/punt-chips';
import { buySell, type FormSwing } from '../lib/buy-sell';
import { rivals } from '../lib/standings';
import { judge } from '../lib/trade-fairness';
import { type CategoryEffect, findTrades, type FoundTrade, nearestInValue, openSide, type Suggestion, suggestTrades } from '../lib/trade-suggest';
import { hasWeekGames, recentForm, type ValueUnit } from '../lib/week-value';
import { describeSettings } from './LeagueParts';
import { useEspnSync } from './LeagueSync';
import { PlayerPicker } from './PlayerPicker';
import ExplainTrade from './ExplainTrade';
import { TradeScorecard } from './TradeScorecard';
import { Card, InjuryTag, injuryDetail, Loading, Problem, Segmented, Signed, Td, Th, Unvalidated } from './ui';
import type { BoardColumn, ExportedRow } from '../generated/columns';

interface PlayerRowFields {
  player_id: string;
  full_name: string | null;
  position: string | null;
  team_abbreviation: string | null;
  games_share: number | null;
  ros_factor: number | null;
  availability_multiplier?: number | null;
  season_complete: boolean;
  games_remaining: number | null;
  injury_status: string | null;
  injury_group: string | null;
  injury_type?: string | null;
  games_this_week?: number | null;
  expected_return?: string | null;
  injury_note?: string | null;
  injury_news?: string | null;
  injury_since?: string | null;
  injury_source?: string | null;
  official_game_date?: string | null;
  official_report_at?: string | null;
  [key: string]: unknown;
}
// Only columns the export ships (export/layout.py): a field it does not ship fails the type check (#479).
type PlayerRow = ExportedRow<BoardColumn, PlayerRowFields>;

/** A player's worth under the league's settings (league-model.ts). */
type Value = Worth;

type Side = 'give' | 'get';

const input = 'rounded border border-line bg-bg px-2 py-1 text-sm';
const button = 'rounded border border-line px-2 py-1 text-xs hover:bg-bg disabled:opacity-50';

const optionLabel = (p: PlayerRow) => `${p.full_name ?? p.player_id} · ${p.team_abbreviation ?? 'FA'} · ${p.position ?? '–'}`;


/** The figure a trade is judged on, as a short label: the rest of the season, or this fantasy week (#466). */
const UNIT_TEXT: Record<ValueUnit, string> = { rest: 'rest of season', week: 'rest of this fantasy week' };

/** The page's three tools (#720): build a trade, find one across the league, or start from the build's chips and targets. */
type Tab = 'build' | 'find' | 'chips';

/** One line of the Buy & sell lists: the player, the run against the projection, and the action. */
function SwingRow({ s, name, team, action, onAction }: { s: FormSwing; name: string; team: string | null; action: string; onAction: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2" data-testid="swing">
      <span className="min-w-0 flex-1 truncate">
        {name} {team && <span className="text-xs text-muted">{team}</span>}
      </span>
      <span className="text-xs text-muted" title="Value per game above replacement: the last ten games against the projection">
        {fmt(s.recent, 1)} lately vs {fmt(s.projected, 1)} projected
      </span>
      <button type="button" className="rounded border border-line px-2 py-1 text-xs hover:bg-bg" onClick={onAction}>
        {action}
      </button>
    </li>
  );
}

export default function TradeAnalyzer() {
  const [tab, setTab] = useState<Tab>('build');
  // the numbers under the verdict: one card, closed until asked for, players or categories
  const [numbers, setNumbers] = useState<'players' | 'categories'>('players');
  const [league] = useState<League>(() => currentLeague());
  const [rows, setRows] = useState<PlayerRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [setup, updateLeague] = useLeague(league);
  // a player page's "Offer" or "Trade for" link puts the player on a side (#726)
  const [fromLink] = useState(() => new URLSearchParams(window.location.search));
  const [give, setGive] = useState<string[]>(() => fromLink.getAll('give'));
  const [get, setGet] = useState<string[]>(() => fromLink.getAll('get'));
  const [partner, setPartner] = useState<number | null>(null);
  const [unit, setUnit] = useState<ValueUnit>('rest');

  useEffect(() => {
    let live = true;
    fetchBuildJson<PlayerRow[]>(`board/${league}.json`)
      .then((data) => live && setRows(data))
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, [league]);

  // an ESPN league is read again on a visit, so the trade is judged on current rosters (#815)
  useEspnSync(setup, updateLeague, rows);
  const owner = useMemo(() => owners(setup), [setup]);
  const hasRosters = owner.size > 0;
  // the partner of a linked trade is the team that has the player asked for
  useEffect(() => {
    const t = fromLink.get('get') ? owner.get(fromLink.get('get')!) : undefined;
    if (t !== undefined && t !== setup.mine) setPartner(t);
    // once, from the link
  }, []);
  const byId = useMemo(() => new Map((rows ?? []).map((r) => [r.player_id, r])), [rows]);
  const pool = setup.teams * setup.rosterSpots;
  const points = setup.scoring === 'points';
  // The league's categories less its punts (#661): a punted category counts for nothing in a trade.
  const cats = useMemo(() => keptCategories(setup), [setup]);
  // The kept categories each count once; punted ones not at all (#661).
  const catWeight = useMemo(() => categoryWeights(setup), [setup]);
  const punted = points ? [] : setup.punts;
  const catValues = useMemo(() => (rows && !points ? categoryValues(rows, cats, pool, setup.teams) : null), [rows, points, cats, pool, setup.teams]);
  const pointVals = useMemo(() => (rows && points ? pointValues(rows, setup.weights, pool, setup.teams) : null), [rows, points, pool, setup.teams, setup.weights]);
  // The week unit is offered while the week has games left; it re-measures the categories on last-ten form.
  const weekAvailable = useMemo(() => !!rows && hasWeekGames(rows), [rows]);
  const week = unit === 'week' && weekAvailable;
  // After the last game the season's value is the projection for the next one (#450).
  const complete = !!rows?.length && rows.every((r) => r.season_complete);
  const REST = week ? UNIT_TEXT.week : complete ? 'next season' : UNIT_TEXT.rest;
  const recentCats = useMemo(
    () => (rows && !points && week ? categoryValues(recentForm(rows, cats), cats, pool, setup.teams, rows) : null),
    [rows, points, week, cats, pool, setup.teams],
  );

  // The partner defaults to the first team that is not the manager's.
  const partnerTeam = partner ?? setup.names.findIndex((_, i) => i !== setup.mine);

  const worth = useMemo(
    () => playerWorth(rows ?? [], { points, cats, catWeight, catValues, pointValues: pointVals, recentCats }),
    [rows, catValues, pointVals, points, cats, recentCats, catWeight],
  );

  const options = useMemo(() => new Map((rows ?? []).map((p) => [optionLabel(p), p.player_id])), [rows]);

  // The league as the standings model reads it (league-model.ts); the standings also need a rival roster.
  const state = useMemo<LeagueState | null>(
    () =>
      rows
        ? leagueState(rows, { league, format: setup.format, points, cats, rosters: setup.rosters, il: setup.il, rosterSpots: setup.rosterSpots, owner, worth, week })
        : null,
    [rows, points, worth, week, league, setup.format, setup.rosters, setup.il, setup.rosterSpots, cats, owner],
  );
  const standings = useMemo(() => (state ? leagueStandings(state, setup.mine) : null), [state, setup.mine]);
  const marketPrices = useMemo(() => (rows ? marketMap(rows, worth) : new Map<string, number>()), [rows, worth]);
  const fairness = useMemo<FairnessModel>(
    () => ({
      state,
      mine: setup.mine,
      value: (id) => {
        const w = worth.get(id);
        return w ? (week ? w.week : w.rest) : 0;
      },
      market: marketPrices,
      ranked: (id) => typeof byId.get(id)?.market_rank === 'number',
    }),
    [state, setup.mine, worth, week, byId, marketPrices],
  );
  /** A trade's value and market lenses for the manager, the roster spots settled (#692). */
  const lensesFor = useCallback((partnerIdx: number, g: string[], r: string[]) => tradeLenses(fairness, partnerIdx, g, r), [fairness]);
  /** Not a bad trade for the manager on value or market: what suggestions and the finder keep (#692). */
  const acceptableFor = useCallback((partnerIdx: number, g: string[], r: string[]) => acceptable(fairness, partnerIdx, g, r), [fairness]);

  // Trade chips and targets for a punt build (#671): where each player ranks on rest-of-season value
  // over every category the league counts (roughly where other managers see him) against where he
  // ranks over the kept ones (where the build does). A gap of a round or more counts.
  // Buy low, sell high (#739): last-ten form against the projection, value per game under the
  // league's scoring, for every rostered player. Categories leagues only: the form is in z-scores.
  const swings = useMemo(() => {
    if (!rows || points || !hasRosters) return null;
    const form = categoryValues(recentForm(rows, cats), cats, pool, setup.teams, rows);
    const mine = (setup.rosters[setup.mine] ?? []).filter((id) => !setup.il.includes(id));
    const projected = (id: string) => worth.get(id)?.perGame ?? 0;
    return buySell({
      mine: setup.mine,
      owner: new Map([...owner].filter(([id]) => !setup.il.includes(id))),
      projected,
      recent: (id) => weightedSum(form.get(id), catWeight),
      healthy: (id) => !['out', 'doubtful'].includes(byId.get(id)?.injury_group ?? ''),
      // good enough to start for you: at least your median player's projection
      startLine: median(mine.map(projected)),
    });
  }, [rows, points, hasRosters, cats, pool, setup.teams, setup.rosters, setup.mine, setup.il, owner, worth, catWeight, byId]);

  const chipsAndTargets = useMemo(() => {
    if (!rows || points || !hasRosters || !punted.length) return null;
    const counted = keptCategories({ scoring: setup.scoring, punts: [] });
    const everyCat = categoryValues(rows, counted, pool, setup.teams);
    const allValue = new Map(
      rows.map((r) => [r.player_id, scaleValue(counted.reduce((s, c) => s + (everyCat.get(r.player_id)?.[c] ?? 0), 0) + marketPriorShift(r), r)]),
    );
    const ids = rows.map((r) => r.player_id);
    const league = ranks(ids, (id) => allValue.get(id) ?? 0);
    const build = ranks(ids, (id) => worth.get(id)?.rest ?? 0);
    const mine = (setup.rosters[setup.mine] ?? []).filter((id) => !setup.il.includes(id));
    const elsewhere = setup.rosters.flatMap((r, t) => (t === setup.mine ? [] : r.filter((id) => !setup.il.includes(id))));
    return {
      chips: tradeChips(mine, league, build, { pool, minGap: setup.teams }),
      targets: tradeTargets(elsewhere, league, build, { ceiling: median(mine.map((id) => build.get(id) ?? Infinity)), minGap: setup.teams }),
    };
  }, [rows, points, hasRosters, punted, setup.scoring, setup.rosters, setup.mine, setup.il, setup.teams, pool, worth]);

  // The trade finder (#664): on request, the best trades with every partner. The search tries a
  // few thousand trades, so it runs when asked rather than on every change.
  const [finding, setFinding] = useState(false);
  // Suggestions and the finder: only trades that raise the partner's expected categories too (#682).
  const [winWin, setWinWin] = useState(true);
  const found = useMemo<FoundTrade[] | null>(() => {
    if (!finding || !state || !standings) return null;
    const rest = new Map([...worth].map(([id, w]) => [id, Math.max(0, week ? w.week : w.rest)]));
    return findTrades({
      mine: state.rosters[setup.mine] ?? [],
      partners: rivals(state.rosters, setup.mine, state.rosterSpots).map((team) => ({ team, roster: state.rosters[team] ?? [] })),
      rest,
      effect: (team, g, r) => {
        const e = tradeImpact(state, standings, setup.mine, team, g, r);
        return { gain: e.mine.gain, partnerGain: e.partner.gain, ups: e.ups, downs: e.downs };
      },
      minGain: meaningful(state, setup.mine),
      winWin,
      acceptable: acceptableFor,
      position: (id) => byId.get(id)?.position,
    });
  }, [finding, state, standings, worth, week, setup.mine, byId, winWin, acceptableFor]);

  if (error) return <Problem error={error} />;
  if (!rows) return <Loading what="the board" />;

  // The figure each side is judged on: the rest of the season, or this fantasy week.
  const NONE: Value = { perGame: 0, season: 0, rest: 0, week: 0, cats: {}, fpts: null };
  const pick = (w: Value) => (week ? w.week : w.rest);
  // A player below replacement is worth zero in a trade, not less: either side could drop him for
  // a free agent. Counting his negative value would make giving him away look like a gain, and a
  // package padded with him look closer to even than it is.
  const floor = (v: number) => Math.max(0, v);
  const sideOf = (ids: string[]) => {
    const players = ids.map((id) => byId.get(id)).filter((p): p is PlayerRow => !!p);
    const sum = (f: (w: Value) => number) =>
      players.reduce((s, p) => s + floor(f(worth.get(p.player_id) ?? NONE)), 0);
    const catSum = (f: (w: Value) => number) =>
      players.reduce((s, p) => s + f(worth.get(p.player_id) ?? NONE), 0);
    // the categories are what the player actually produces, so they keep their sign
    const catTotals = Object.fromEntries(cats.map((c) => [c, catSum((w) => w.cats[c] ?? 0)]));
    const belowReplacement = players.filter((p) => pick(worth.get(p.player_id) ?? NONE) < 0);
    const games = players.reduce((s, p) => s + (p.games_this_week ?? 0), 0);
    return {
      players,
      perGame: sum((w) => w.perGame),
      season: sum((w) => w.season),
      rest: sum((w) => w.rest),
      week: sum((w) => w.week),
      value: sum(pick),
      games,
      cats: catTotals,
      belowReplacement,
    };
  };
  const giving = sideOf(give);
  const getting = sideOf(get);
  const net = getting.value - giving.value;
  const scale = Math.max(Math.abs(giving.value), Math.abs(getting.value), 1);
  const spots = getting.players.length - giving.players.length;

  // The manager's team before and after, with its rank in each category among the league's teams.
  const myRoster = hasRosters ? (setup.rosters[setup.mine] ?? []) : null;
  // Players on the injured list are owned but not playing: they stay out of a team's totals.
  const teamTotals = (roster: string[]) =>
    Object.fromEntries(cats.map((c) => [c, roster.filter((id) => !setup.il.includes(id)).reduce((s, id) => s + (worth.get(id)?.cats[c] ?? 0), 0)]));
  const change = (() => {
    if (!myRoster || points) return null;
    const after = (t: number) => {
      const roster = setup.rosters[t] ?? [];
      if (t === setup.mine) return [...roster.filter((id) => !give.includes(id)), ...get];
      if (t === partnerTeam) return [...roster.filter((id) => !get.includes(id)), ...give];
      return roster;
    };
    const before = setup.rosters.map((r) => teamTotals(r));
    const afterTotals = setup.rosters.map((_, t) => teamTotals(after(t)));
    const rankOf = (totals: Record<string, number>[], c: string) => {
      const order = totals
        .map((tot, t) => ({ t, v: tot[c] ?? 0, size: (setup.rosters[t] ?? []).length }))
        .filter((x) => x.size > 0 || x.t === setup.mine)
        .sort((a, b) => b.v - a.v);
      return order.findIndex((x) => x.t === setup.mine) + 1;
    };
    const ranked = setup.rosters.filter((r) => r.length > 0).length;
    return {
      ranked,
      rows: cats.map((c) => ({
        c,
        before: before[setup.mine]?.[c] ?? 0,
        after: afterTotals[setup.mine]?.[c] ?? 0,
        rankBefore: rankOf(before, c),
        rankAfter: rankOf(afterTotals, c),
      })),
    };
  })();

  // Suggestions: packages from the open side's roster that make the trade about even, ranked by the
  // category ranks they gain the manager; without rosters, players worth about the same as the target.
  const ready = giving.players.length > 0 || getting.players.length > 0;
  // What the trade does to both teams' categories (#663); null without the standings.
  const impact = state && standings && ready && partnerTeam >= 0 ? tradeImpact(state, standings, setup.mine, partnerTeam, give, get) : null;
  const threshold = state ? meaningful(state, setup.mine) : 0;
  const h2h = setup.format === 'h2h';
  const partnerName = setup.names[partnerTeam] ?? 'Your partner';
  // Is it even? (#692) Projected value with the roster spots settled, the market, and the categories:
  // even only when they agree; a warning when any says the trade is bad for the manager.
  const lenses = ready ? lensesFor(hasRosters ? partnerTeam : -1, give, get) : null;
  const fair = lenses ? judge(lenses.value, lenses.market, impact ? impact.mine.gain : null, threshold) : null;
  const settledNote = lenses?.settled && (lenses.settled.dropped.length > 0 || lenses.settled.added.length > 0);
  // Both sides in the same depth (#682): each team's needs from the standings, and the trade
  // judged by both teams' change in expected categories.
  const needs = impact && state && standings ? { mine: teamNeeds(state, standings, setup.mine), partner: teamNeeds(state, standings, partnerTeam) } : null;
  const verdictBoth = impact && state ? objective(impact.mine.gain, impact.partner.gain, threshold) : null;

  // This week's matchup before and after (#674): a head-to-head league with an opponent set and
  // games left this week, on the projected line over the games left, as the board's matchup card.
  const opponent = h2h && setup.opponent !== null && weekAvailable && state ? setup.opponent : null;
  const weekMatch = (() => {
    if (opponent === null || !state || !ready) return null;
    const rowsOf = (ids: string[]) => ids.map((id) => byId.get(id)).filter((p): p is PlayerRow => !!p);
    const sides = rostersAfter(state, setup.mine, partnerTeam, give, get);
    const theirs = state.rosters[opponent] ?? [];
    const before = matchup(cats, weekTotals(rowsOf(state.rosters[setup.mine] ?? []), cats), weekTotals(rowsOf(theirs), cats));
    const after = matchup(
      cats,
      weekTotals(rowsOf(sides.mine.after), cats),
      weekTotals(rowsOf(opponent === partnerTeam ? sides.partner.after : theirs), cats),
    );
    const flips = after.cats.filter((r) => r.result !== before.cats.find((b) => b.cat === r.cat)?.result);
    return { before, after, flips, name: setup.names[opponent] ?? 'your opponent' };
  })();
  const record = (m: { wins: number; losses: number; close: number }) => `${m.wins}–${m.losses}${m.close ? `–${m.close}` : ''}`;
  const restOf = new Map([...worth].map(([id, w]) => [id, Math.max(0, pick(w))]));
  const active = (t: number) => (setup.rosters[t] ?? []).filter((id) => !setup.il.includes(id));
  const open = openSide(give, get, restOf);
  const suggestions =
    ready && hasRosters && partnerTeam >= 0
      ? suggestTrades({
          give,
          get,
          mine: active(setup.mine),
          theirs: active(partnerTeam),
          rest: restOf,
          effect:
            state && standings
              ? (g, r): CategoryEffect => {
                  const e = tradeImpact(state, standings, setup.mine, partnerTeam, g, r);
                  return { gain: e.mine.gain, partnerGain: e.partner.gain, ups: e.ups, downs: e.downs };
                }
              : undefined,
          minGain: threshold || undefined,
          winWin,
          acceptable: (g, r) => acceptableFor(partnerTeam, g, r),
          position: (id) => byId.get(id)?.position,
        })
      : [];
  const targetSide: Side = get.length ? 'get' : 'give';
  const nearest = ready && !hasRosters ? nearestInValue(targetSide === 'get' ? get : give, restOf, [...give, ...get]) : [];
  const nameOf = (id: string) => byId.get(id)?.full_name ?? id;
  const nameList = (ids: string[]) => ids.map(nameOf).join(' + ');
  const applySuggestion = (s: Suggestion) => {
    setGive(s.give);
    setGet(s.get);
  };
  const catList = (list: string[]) => list.map((c) => CATEGORY_LABELS[c] ?? c).join(', ');
  /** The categories a change moves the manager's chances in, up and down. */
  const catMoves = (ups: string[], downs: string[]) =>
    ups.length || downs.length ? (
      <span className="whitespace-nowrap">
        {ups.length > 0 && <span className="text-good">↑ {catList(ups)}</span>}
        {ups.length > 0 && downs.length > 0 && ' '}
        {downs.length > 0 && <span className="text-bad">↓ {catList(downs)}</span>}
      </span>
    ) : (
      <span className="text-muted">no category moves</span>
    );
  const effectCell = (e: CategoryEffect) => (
    <span className="flex flex-wrap items-center gap-x-2">
      <Signed value={e.gain} digits={2} />
      {catMoves(e.ups, e.downs)}
    </span>
  );
  /** Whole-percent win chance. */
  const chance = (p: number | undefined) => `${Math.round((p ?? 0) * 100)}%`;
  /** Who the partner is likely to see it: their categories and their value. */
  const acceptance = (partnerGain: number, partnerValue: number, scale: number) =>
    partnerGain >= 0 && partnerValue >= -0.05 * scale
      ? 'Good for them on both counts: a trade they have reason to accept.'
      : partnerGain >= 0
        ? 'Their categories improve though they give up value: worth offering to a manager who builds for categories.'
        : partnerValue >= 0
          ? 'They gain value but lose ground in their categories: a manager who goes by rankings may take it.'
          : 'They lose on both counts: unlikely to be accepted.';
  const market = (ids: string[]) =>
    ids
      .map((id) => byId.get(id)?.market_rank)
      .filter((r): r is number => typeof r === 'number')
      .map((r) => `#${r}`)
      .join(', ');

  const add = (side: Side, id: string) => (side === 'give' ? setGive : setGet)((s) => (s.includes(id) ? s : [...s, id]));
  const remove = (side: Side, id: string) => (side === 'give' ? setGive : setGet)((s) => s.filter((x) => x !== id));
  const toggle = (side: Side, id: string, on: boolean) => (on ? add(side, id) : remove(side, id));

  const rosterPicker = (side: Side, team: number, picked: string[]) => {
    const roster = (setup.rosters[team] ?? [])
      .map((id) => byId.get(id))
      .filter((p): p is PlayerRow => !!p)
      .sort((a, b) => pick(worth.get(b.player_id) ?? NONE) - pick(worth.get(a.player_id) ?? NONE));
    if (!roster.length) return <p className="text-xs text-muted">No players on this roster yet: add them on the League page, or search below.</p>;
    return (
      <ul className="grid gap-0.5 text-sm" data-testid={`roster-${side}`}>
        {roster.map((p) => (
          <li key={p.player_id}>
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={picked.includes(p.player_id)} onChange={(e) => toggle(side, p.player_id, e.target.checked)} />
              <span className="min-w-0 flex-1 truncate">{p.full_name ?? p.player_id}</span>
              {setup.il.includes(p.player_id) && (
                <span className="rounded border border-warn px-1 text-[10px] font-semibold text-warn" title="On the injured list">
                  IL
                </span>
              )}
              <span className="text-xs text-muted">{p.position ?? '–'}</span>
              <span className="w-12 text-right tabular-nums"><Signed value={pick(worth.get(p.player_id) ?? NONE)} digits={1} /></span>
            </label>
          </li>
        ))}
      </ul>
    );
  };

  const sideCard = (side: Side, title: string, team: number | null, picked: string[]) => (
    <Card title={title} id={`trade-${side}`}>
      <div className="grid gap-3">
        {hasRosters && team !== null && team >= 0 && (
          <div>
            {side === 'get' ? (
              <label className="mb-2 flex items-center gap-2 text-sm">
                Trade partner{' '}
                <select value={team} onChange={(e) => setPartner(Number(e.target.value))} className={input} aria-label="Trade partner">
                  {setup.names.map((name, i) => (
                    i !== setup.mine && (
                      <option key={i} value={i}>
                        {name}
                      </option>
                    )
                  ))}
                </select>
              </label>
            ) : (
              <p className="mb-2 text-sm text-muted">
                Your team: <strong className="text-fg">{setup.names[team]}</strong>
              </p>
            )}
            {rosterPicker(side, team, picked)}
          </div>
        )}
        <PlayerPicker label={side === 'give' ? 'Add a player you give' : 'Add a player you get'} options={options} onAdd={(id) => add(side, id)} />
        {picked.length > 0 && (
          <ul className="flex flex-wrap gap-1" data-testid={`picked-${side}`}>
            {picked.map((id) => {
              const p = byId.get(id);
              return (
                <li key={id}>
                  <button type="button" className={`${button} flex items-center gap-1`} onClick={() => remove(side, id)} title="Remove from the trade">
                    {p?.full_name ?? id} <span aria-hidden="true">×</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );

  // More of each player than his value (#694): where the market ranks him, his form over the last
  // ten games against his projection in the kept categories, what he is good and bad at, and when
  // that makes the timing good or bad.
  const numOf = (p: PlayerRow, key: string) => {
    const v = p[key];
    return typeof v === 'number' && !Number.isNaN(v) ? v : null;
  };
  const formOf = (p: PlayerRow): number | null => {
    let sum = 0;
    let seen = false;
    for (const c of cats) {
      const recent = numOf(p, `recent_${c}`);
      const proj = numOf(p, c);
      if (recent === null || proj === null) continue;
      sum += recent - proj;
      seen = true;
    }
    return seen ? sum : null;
  };
  const HOT = 1.5;
  const profileOf = (p: PlayerRow) => {
    const c = worth.get(p.player_id)?.cats ?? {};
    const order = cats.filter((k) => typeof c[k] === 'number').sort((a, b) => (c[b] ?? 0) - (c[a] ?? 0));
    const best = order.filter((k) => (c[k] ?? 0) > 0.5).slice(0, 2);
    const worst = order.filter((k) => (c[k] ?? 0) < -0.5).slice(-1);
    return { best, worst };
  };
  const timing = [...giving.players.map((p) => ['give', p] as const), ...getting.players.map((p) => ['get', p] as const)].flatMap(([side, p]) => {
    const name = p.full_name ?? p.player_id;
    const notes: string[] = [];
    const form = points ? null : formOf(p);
    if (form !== null && form >= HOT)
      notes.push(
        side === 'give'
          ? `${name} has run ${fmt(form, 1)} above their projection over the last ten games: you sell high.`
          : `${name} has run ${fmt(form, 1)} above their projection over the last ten games: you buy at the top, and the projection expects them to cool off.`,
      );
    if (form !== null && form <= -HOT)
      notes.push(
        side === 'give'
          ? `${name} has run ${fmt(-form, 1)} below their projection over the last ten games: you sell low, and the projection expects them to recover.`
          : `${name} has run ${fmt(-form, 1)} below their projection over the last ten games: you buy low.`,
      );
    if (p.injury_group === 'out' || p.injury_group === 'doubtful')
      notes.push(
        `${name} is ${(p.injury_status ?? 'out').toLowerCase()}${p.expected_return ? ` (expected back ${p.expected_return})` : ''}: the value counts only the games they are expected to play.`,
      );
    return notes;
  });

  // What the AI is given to explain (ADR 0017): the scorecard's numbers as shown, no more (#702).
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const catLabels = (list: string[]) => list.map((c) => CATEGORY_LABELS[c] ?? c);
  const aiFacts = fair
    ? {
        you_give: giving.players.map((p) => p.full_name ?? p.player_id),
        you_get: getting.players.map((p) => p.full_name ?? p.player_id),
        partner: partnerName,
        verdict: fair.severity !== 'fine' ? `bad for you (${fair.severity})` : fair.even ? 'fair' : fair.disagree ? 'a judgment call' : 'not even',
        your_categories_a_week: impact ? { before: r2(impact.mine.scoreBefore), after: r2(impact.mine.scoreAfter), change: r2(impact.mine.gain) } : null,
        partner_categories_a_week: impact ? { before: r2(impact.partner.scoreBefore), after: r2(impact.partner.scoreAfter), change: r2(impact.partner.gain) } : null,
        your_categories_up: impact ? catLabels(impact.ups) : [],
        your_categories_down: impact ? catLabels(impact.downs) : [],
        partner_categories_up: impact ? catLabels(impact.partnerUps) : [],
        partner_categories_down: impact ? catLabels(impact.partnerDowns) : [],
        projected_value_lean_percent_positive_favours_you: Math.round(fair.value.share * 100),
        market_lean_percent_positive_favours_you: fair.market ? Math.round(fair.market.share * 100) : null,
        warnings: fair.reasons,
        timing,
      }
    : null;

  const playerRow = (p: PlayerRow) => {
    const w = worth.get(p.player_id);
    const form = points ? null : formOf(p);
    const profile = points ? null : profileOf(p);
    const market = numOf(p, 'market_rank');
    return (
      <tr key={p.player_id} className="border-t border-line">
        <Td pin="first">
          <span className="flex items-center gap-1 whitespace-nowrap">
            <a href={href(`/p/${league}/${p.player_id}/`)} className="underline-offset-4 hover:underline">
              {p.full_name ?? p.player_id}
            </a>
            <InjuryTag group={p.injury_group} status={p.injury_status} detail={injuryDetail(p)} />
          </span>
        </Td>
        <Td>{p.team_abbreviation ?? '–'}</Td>
        <Td>{p.position ?? '–'}</Td>
        <Td right>{market === null ? '–' : `#${market}`}</Td>
        {!points && (
          <Td right>
            <span
              className={form !== null && form >= HOT ? 'font-semibold text-good' : form !== null && form <= -HOT ? 'font-semibold text-bad' : ''}
              title="Last ten games against the projection, summed over your kept categories"
            >
              {form === null ? '–' : `${form > 0 ? '+' : ''}${fmt(form, 1)}${form >= HOT ? ' hot' : form <= -HOT ? ' cold' : ''}`}
            </span>
          </Td>
        )}
        {!points && (
          <Td>
            <span className="whitespace-nowrap text-xs">
              {profile && profile.best.length > 0 && <span className="text-good">{profile.best.map((c) => CATEGORY_LABELS[c] ?? c).join(' ')}</span>}
              {profile && profile.worst.length > 0 && <span className="text-bad"> · {profile.worst.map((c) => CATEGORY_LABELS[c] ?? c).join(' ')}</span>}
              {profile && !profile.best.length && !profile.worst.length && <span className="text-muted">balanced</span>}
            </span>
          </Td>
        )}
        {!complete && <Td right>{p.games_remaining ?? '–'}</Td>}
        {points && <Td right>{fmt(w?.fpts ?? null)}</Td>}
        <Td right>
          <Signed value={w?.perGame ?? 0} />
        </Td>
        <Td right>{pct(p.games_share)}</Td>
        <Td right>
          <Signed value={w?.season ?? 0} />
        </Td>
        {!complete && <Td right>{pct(p.ros_factor)}</Td>}
        {!complete && (
          <Td right>
            <Signed value={w?.rest ?? 0} />
          </Td>
        )}
        {weekAvailable && <Td right>{p.games_this_week ?? 0}</Td>}
        {weekAvailable && (
          <Td right>
            <Signed value={w?.week ?? 0} />
          </Td>
        )}
      </tr>
    );
  };

  const totalRow = (label: string, s: ReturnType<typeof sideOf>, testid: string) => (
    <tr className="border-t border-line font-semibold" data-testid={testid}>
      <Td>{label}</Td>
      <Td>{''}</Td>
      <Td>{s.players.length ? `${s.players.length} player${s.players.length === 1 ? '' : 's'}` : '–'}</Td>
      <Td right>{''}</Td>
      {!points && <Td right>{''}</Td>}
      {!points && <Td>{''}</Td>}
      {!complete && <Td right>{s.players.reduce((n, p) => n + (p.games_remaining ?? 0), 0)}</Td>}
      {points && <Td right>{''}</Td>}
      <Td right>
        <Signed value={s.perGame} />
      </Td>
      <Td right>{''}</Td>
      <Td right>
        <Signed value={s.season} />
      </Td>
      {!complete && <Td right>{''}</Td>}
      {!complete && (
        <Td right>
          <Signed value={s.rest} />
        </Td>
      )}
      {weekAvailable && <Td right>{s.games}</Td>}
      {weekAvailable && (
        <Td right>
          <Signed value={s.week} />
        </Td>
      )}
    </tr>
  );

  const rankTone = (before: number, after: number) => (after < before ? 'text-good' : after > before ? 'text-bad' : '');
  const chanceTone = (before: number, after: number) => (after - before >= 0.005 ? 'text-good' : before - after >= 0.005 ? 'text-bad' : '');

  const hasChips = !!chipsAndTargets && (chipsAndTargets.chips.length > 0 || chipsAndTargets.targets.length > 0);
  const hasSwings = !!swings && (swings.buyLow.length > 0 || swings.sellHigh.length > 0);
  const tabs: { id: Tab; label: string; title: string }[] = [
    { id: 'build', label: 'Build', title: 'Pick the players each side gives and see the verdict' },
    ...(standings ? [{ id: 'find' as const, label: 'Find', title: 'Trades across your league that win you categories' }] : []),
    ...(hasChips || hasSwings
      ? [{ id: 'chips' as const, label: 'Buy & sell', title: 'Players to buy low and sell high on form, and the chips and targets your punts make' }]
      : []),
  ];
  // a tab whose tool has gone (no rival rosters, no punts) falls back to Build
  const current: Tab = tabs.some((x) => x.id === tab) ? tab : 'build';

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">

      {!hasRosters && (
        <p className="text-sm text-muted" data-testid="trade-no-league">
          {/* The same summary as the League bar, so it follows the settings (#453). */}
          Values are for {isDefaultSettings(setup, DEFAULT_SETTINGS[league]) ? 'the default league' : 'your settings'} (
          <span data-testid="trade-settings">{describeSettings(setup)}</span>). Set up your league&apos;s size, scoring and
          rosters on the <a href={href('/league/')} className="underline underline-offset-4">League page</a> to value a trade for your league and
          see your team before and after.
        </p>
      )}

      {tabs.length > 1 && (
        <div className="-mb-2" data-testid="trade-tabs">
          <Segmented label="Trade tools" value={current} options={tabs} onChange={setTab} />
        </div>
      )}

      {current === 'build' && (
        <div className="grid gap-6 md:grid-cols-2">
          {sideCard('give', 'You give', hasRosters ? setup.mine : null, give)}
          {sideCard('get', 'You get', hasRosters ? partnerTeam : null, get)}
        </div>
      )}

      {current === 'find' && standings && (
        <Card title="Trades across your league" id="finder" badge={<Unvalidated issue={888} what="The trade finder" />}>
          <label className="mb-2 flex items-center gap-2 text-sm" title="Both teams' expected categories must rise">
            <input type="checkbox" checked={winWin} onChange={(e) => setWinWin(e.target.checked)} data-testid="win-win" />
            Win-win only
          </label>
          {!found ? (
            <div className="grid gap-2 text-sm">
              <p className="text-muted">
                One-for-one, two-for-one and one-for-two trades with every team, kept when they raise the categories you expect to win and give the other
                team a reason to say yes: their categories rise too, or they gain value.
              </p>
              <button type="button" className={`${button} justify-self-start`} onClick={() => setFinding(true)} data-testid="find-trades">
                Find trades
              </button>
            </div>
          ) : found.length ? (
            <ul className="grid gap-2 text-sm" data-testid="found-trades">
              {found.map((t) => (
                <li key={`${t.partner}:${t.give.join()}>${t.get.join()}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-line p-2">
                  <span className="min-w-0">
                    <strong>{setup.names[t.partner]}</strong>
                    <span className="text-muted">: you give </span>
                    {nameList(t.give)}
                    <span className="text-muted">, you get </span>
                    {nameList(t.get)}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className="text-xs text-muted">Your categories</span>
                    {effectCell(t.effect)}
                  </span>
                  <span>
                    <span className="text-xs text-muted">Theirs </span>
                    <Signed value={t.effect.partnerGain} digits={2} />
                  </span>
                  <span>
                    <span className="text-xs text-muted">Value </span>
                    <Signed value={t.net} digits={1} />
                  </span>
                  <button
                    type="button"
                    className={button}
                    onClick={() => {
                      setPartner(t.partner);
                      setGive(t.give);
                      setGet(t.get);
                      setTab('build');
                    }}
                  >
                    Use this trade
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted" data-testid="found-none">
              {winWin
                ? 'No one-for-one, two-for-one or one-for-two trade raises the categories both teams expect to win. Untick win-win only to see trades that pay the other team in value instead.'
                : 'No one-for-one, two-for-one or one-for-two trade raises the categories you expect to win on terms the other team has a reason to accept.'}
            </p>
          )}
          {found && (
            <p className="mt-2 text-xs text-muted">
              Your categories: the change in the categories you expect to win {setup.format === 'h2h' ? 'a week' : '(rotisserie points)'}; theirs: the other
              team&apos;s. Biggest gain first, at most three a team, over each roster&apos;s eight most valuable players.
            </p>
          )}
        </Card>
      )}

      {current === 'chips' && swings && hasSwings && (
        <Card title="Buy low, sell high" id="buy-sell" badge={<Unvalidated issue={758} what="Buy low, sell high" />}>
          <p className="mb-3 text-sm text-muted">
            Recent form against the projection, in value per game above replacement under your league&apos;s scoring. Managers price players on the box
            scores they have just seen: a hot run sells for more than the projection says, a slump buys for less.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h3 className="mb-1 text-sm font-semibold">Sell high: yours, running hot</h3>
              {swings.sellHigh.length ? (
                <ul className="grid gap-1 text-sm" data-testid="sell-high">
                  {swings.sellHigh.map((s) => (
                    <SwingRow
                      key={s.id}
                      s={s}
                      name={nameOf(s.id)}
                      team={null}
                      action="Offer"
                      onAction={() => {
                        add('give', s.id);
                        setTab('build');
                      }}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">None of your players is running a point or more above the projection.</p>
              )}
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold">Buy low: theirs, in a slump</h3>
              {swings.buyLow.length ? (
                <ul className="grid gap-1 text-sm" data-testid="buy-low">
                  {swings.buyLow.map((s) => (
                    <SwingRow
                      key={s.id}
                      s={s}
                      name={nameOf(s.id)}
                      team={setup.names[s.team] ?? null}
                      action="Ask for"
                      onAction={() => {
                        setPartner(s.team);
                        add('get', s.id);
                        setTab('build');
                      }}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">No healthy player elsewhere who would start for you is slumping a point or more below the projection.</p>
              )}
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">
            Last ten games against the projection; a swing of a point a game or more counts. Buy-low players are healthy (an injury explains a slump and is
            no discount) and projected at least as high as your median player.
          </p>
        </Card>
      )}

      {current === 'chips' && hasChips && (
        <Card title="Trade chips and targets for your punt" id="chips">
          <p className="mb-3 text-sm text-muted">
            Punting {punted.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}, you rank players differently from the rest of your league. For you: the
            player&apos;s rank on value over the categories you keep. On value: the rank over every category, roughly where other managers see the player.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h3 className="mb-1 text-sm font-semibold">Chips: worth more to others</h3>
              {chipsAndTargets.chips.length ? (
                <ul className="grid gap-1 text-sm" data-testid="trade-chips">
                  {chipsAndTargets.chips.map((v) => (
                    <li key={v.id} className="flex flex-wrap items-center gap-x-2">
                      <span className="min-w-0 flex-1 truncate">{nameOf(v.id)}</span>
                      <span className="text-xs text-muted">
                        #{v.league} on value, #{v.build} for you
                      </span>
                      <button
                        type="button"
                        className={button}
                        onClick={() => {
                          add('give', v.id);
                          setTab('build');
                        }}
                      >
                        Offer
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">None of your players is worth much more to others than to your build.</p>
              )}
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold">Targets: worth more to you</h3>
              {chipsAndTargets.targets.length ? (
                <ul className="grid gap-1 text-sm" data-testid="trade-targets">
                  {chipsAndTargets.targets.map((v) => (
                    <li key={v.id} className="flex flex-wrap items-center gap-x-2">
                      <span className="min-w-0 flex-1 truncate">
                        {nameOf(v.id)} <span className="text-xs text-muted">{setup.names[owner.get(v.id) ?? -1] ?? ''}</span>
                      </span>
                      <span className="text-xs text-muted">
                        #{v.league} on value, #{v.build} for you
                      </span>
                      <button
                        type="button"
                        className={button}
                        onClick={() => {
                          const t = owner.get(v.id);
                          if (t !== undefined) setPartner(t);
                          add('get', v.id);
                          setTab('build');
                        }}
                      >
                        Ask for
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">No player on another roster is worth much more to your build than to the league, among those who would start for you.</p>
              )}
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">
            Ranks on rest-of-season value above replacement, over every player on the board; listed when they differ by a round ({setup.teams} places) or
            more. A chip is a player to sell: other managers pay for categories you do not use. A target is one to buy for less than the player is worth to you,
            among players who would start for you (ranked for you at least as high as your median player).
          </p>
        </Card>
      )}

      {current === 'build' && ready && (
        <Card title="Verdict" id="verdict" badge={<Unvalidated issue={886} what="The trade verdict" />}>
          {weekAvailable && (
            <div className="mb-2">
              <Segmented
                label="Value unit"
                value={week ? 'week' : 'rest'}
                options={[
                  { id: 'rest', label: 'Rest of season', title: 'Projected value over the games each player is expected to play from today' },
                  { id: 'week', label: 'This week', title: 'Last-ten form over the games left this fantasy week (Monday to Sunday)' },
                ]}
                onChange={setUnit}
              />
            </div>
          )}
          <div className="grid gap-2 text-sm" data-testid="trade-verdict">
            {fair && fair.severity !== 'fine' && (
              <div
                role="alert"
                data-testid="trade-warning"
                className={`rounded-lg border-2 p-3 ${fair.severity === 'terrible' ? 'border-bad' : 'border-warn'}`}
              >
                <p className={`text-base font-semibold ${fair.severity === 'terrible' ? 'text-bad' : 'text-warn'}`}>
                  {fair.severity === 'terrible' ? '⚠ Stop: this looks like a terrible trade for you' : '⚠ Careful: this looks like a bad trade for you'}
                </p>
                <ul className="mt-1 list-disc pl-5">
                  {fair.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
            {fair && (
              <TradeScorecard fair={fair} impact={impact} needs={needs} objective={verdictBoth} partnerName={partnerName} h2h={h2h} nameList={nameList} threshold={threshold} />
            )}
            {aiFacts && <ExplainTrade facts={aiFacts} />}
            <details className="rounded-lg border border-line p-2" data-testid="trade-details">
              <summary className="cursor-pointer text-sm font-medium">The full breakdown: how this is worked out</summary>
              <div className="mt-2 grid gap-2">
            {impact && (
              <div className="grid gap-1" data-testid="trade-category-verdict">
                <p className="text-base">
                  <strong>
                    {impact.mine.gain >= threshold ? 'Wins you categories' : impact.mine.gain <= -threshold ? 'Costs you categories' : 'About even in categories'}:
                  </strong>{' '}
                  {h2h ? (
                    <>
                      you would expect to win {fmt(impact.mine.scoreAfter, 2)} of your {cats.length} categories in an average week against your league,
                      from {fmt(impact.mine.scoreBefore, 2)} (<Signed value={impact.mine.gain} digits={2} />
                      ).
                    </>
                  ) : (
                    <>
                      your expected rotisserie points over your {cats.length} categories go from {fmt(impact.mine.scoreBefore, 1)} to{' '}
                      {fmt(impact.mine.scoreAfter, 1)} (<Signed value={impact.mine.gain} digits={1} />
                      ).
                    </>
                  )}
                </p>
                {verdictBoth && (
                  <p data-testid="trade-objective" className={verdictBoth === 'win-win' ? 'font-medium text-good' : verdictBoth === 'neither' ? 'text-bad' : ''}>
                    {verdictBoth === 'win-win'
                      ? 'Win-win: both teams expect to win more categories, an objectively good trade.'
                      : verdictBoth === 'you'
                        ? `Good for you only: ${partnerName} does not gain categories, so they have less reason to accept.`
                        : verdictBoth === 'them'
                          ? `Good for ${partnerName} only: they gain categories and you do not.`
                          : verdictBoth === 'even'
                            ? 'About even for both teams’ categories.'
                            : 'Neither team gains categories.'}
                  </p>
                )}
                {(impact.ups.length > 0 || impact.downs.length > 0) && <p>{catMoves(impact.ups, impact.downs)}</p>}
                {(impact.sides.mine.dropped.length > 0 || impact.sides.mine.added.length > 0) && (
                  <p className="text-muted" data-testid="trade-roster-moves">
                    {impact.sides.mine.dropped.length > 0 && <>To make room you would drop {nameList(impact.sides.mine.dropped)}, your lowest-valued player after the trade. </>}
                    {impact.sides.mine.added.length > 0 && <>You would pick up {nameList(impact.sides.mine.added)}, the best free agent, for the open spot. </>}
                    The categories count {impact.sides.mine.dropped.length > 0 ? 'the drop' : 'the pickup'}.
                  </p>
                )}
                {weekMatch && (
                  <p data-testid="trade-week-matchup">
                    <span className="text-muted">This week against {weekMatch.name}: </span>
                    {record(weekMatch.before)} → <strong>{record(weekMatch.after)}</strong>
                    <span className="text-muted"> (won–lost{weekMatch.before.close || weekMatch.after.close ? '–too close' : ''}, over the games left)</span>
                    {weekMatch.flips.length > 0 ? (
                      <>
                        {'. '}
                        {weekMatch.flips.map((r, i) => {
                          const was = weekMatch.before.cats.find((b) => b.cat === r.cat)?.result ?? 'close';
                          const better = (r.result === 'win' && was !== 'win') || (r.result === 'close' && was === 'loss');
                          return (
                            <span key={r.cat} className={better ? 'text-good' : 'text-bad'}>
                              {i > 0 ? ', ' : ''}
                              {CATEGORY_LABELS[r.cat] ?? r.cat} {was} → {r.result}
                            </span>
                          );
                        })}
                      </>
                    ) : (
                      <span className="text-muted">: no category changes hands.</span>
                    )}
                  </p>
                )}
                <div className="grid gap-1 rounded border border-line p-2" data-testid="trade-partner">
                  <p>
                    <span className="text-muted">For {partnerName}: </span>
                    {h2h ? (
                      <>
                        {fmt(impact.partner.scoreBefore, 2)} → <strong>{fmt(impact.partner.scoreAfter, 2)}</strong> expected categories a week (
                        <Signed value={impact.partner.gain} digits={2} />)
                      </>
                    ) : (
                      <>
                        {fmt(impact.partner.scoreBefore, 1)} → <strong>{fmt(impact.partner.scoreAfter, 1)}</strong> rotisserie points (
                        <Signed value={impact.partner.gain} digits={1} />)
                      </>
                    )}{' '}
                    and <Signed value={-net} digits={1} /> in value. <span className="text-muted">{acceptance(impact.partner.gain, -net, scale)}</span>
                  </p>
                  {(impact.partnerUps.length > 0 || impact.partnerDowns.length > 0) && <p>{catMoves(impact.partnerUps, impact.partnerDowns)}</p>}
                  {(impact.sides.partner.dropped.length > 0 || impact.sides.partner.added.length > 0) && (
                    <p className="text-muted">
                      {impact.sides.partner.dropped.length > 0 && <>They would drop {nameList(impact.sides.partner.dropped)} to make room. </>}
                      {impact.sides.partner.added.length > 0 && <>They would pick up {nameList(impact.sides.partner.added)}, the best free agent left. </>}
                    </p>
                  )}
                </div>
                {needs && (
                  <div className="table-scroll overflow-auto" tabIndex={0} role="region" aria-label="Each team's needs">
                    <table className="w-full text-sm" data-testid="trade-needs">
                      <thead>
                        <tr>
                          <Th>Needs, from the standings</Th>
                          <Th>You</Th>
                          <Th>{partnerName}</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {(
                          [
                            ['Swing categories (close against the league)', 'swing'],
                            ['Conceding (under 25%)', 'conceding'],
                            ['Locked (over 75%)', 'locked'],
                          ] as const
                        ).map(([label, key]) => (
                          <tr key={key} className="border-t border-line">
                            <Td>{label}</Td>
                            {(['mine', 'partner'] as const).map((side) => {
                              const list = needs[side][key];
                              const up = side === 'mine' ? impact.ups : impact.partnerUps;
                              const down = side === 'mine' ? impact.downs : impact.partnerDowns;
                              return (
                                <Td key={side}>
                                  {list.length
                                    ? list.map((c, i) => (
                                        <span key={c} className={key === 'swing' ? (up.includes(c) ? 'text-good' : down.includes(c) ? 'text-bad' : '') : ''}>
                                          {i > 0 ? ', ' : ''}
                                          {CATEGORY_LABELS[c] ?? c}
                                          {key === 'swing' ? (up.includes(c) ? ' ↑' : down.includes(c) ? ' ↓' : '') : ''}
                                        </span>
                                      ))
                                    : '–'}
                                </Td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-1 text-xs text-muted">
                      Swing categories are where a gain moves a team&apos;s chances most; an arrow shows the trade moving one up or down. A good trade for
                      both sides helps each team&apos;s swing categories and costs it only categories it concedes or has locked.
                    </p>
                  </div>
                )}
                {(market(give) || market(get)) && (
                  <p className="text-muted" data-testid="trade-market">
                    ESPN draft ranks, which many managers trade by: you give {market(give) || 'none ranked'}, you get {market(get) || 'none ranked'}.
                  </p>
                )}
              </div>
            )}
            {fair && (
              <div className="grid gap-0.5 rounded border border-line p-2" data-testid="trade-fairness">
                <p className="font-medium">
                  {fair.even
                    ? 'Even: projected value, the market and your categories all agree.'
                    : fair.disagree
                      ? 'Not clearly even: our projections and the market point opposite ways.'
                      : 'Not even.'}
                </p>
                <p>
                  <span className="text-muted">Projected value{settledNote ? ', roster spots counted' : ''}: </span>
                  you give <Signed value={fair.value.give} digits={1} />, get <Signed value={fair.value.get} digits={1} /> (
                  {fair.value.net >= 0 ? 'you +' : 'partner +'}
                  {Math.round(Math.abs(fair.value.share) * 100)}%)
                </p>
                {fair.market && (
                  <p data-testid="trade-fairness-market">
                    <span className="text-muted">The market (ESPN ranks, priced on this board): </span>
                    you give <Signed value={fair.market.give} digits={1} />, get <Signed value={fair.market.get} digits={1} /> (
                    {fair.market.net >= 0 ? 'you +' : 'partner +'}
                    {Math.round(Math.abs(fair.market.share) * 100)}%)
                  </p>
                )}
                {fair.disagree && (
                  <p className="text-muted" data-testid="trade-fairness-disagree">
                    Our projections favour {fair.value.net >= 0 ? 'you' : partnerName}; the market favours {fair.market && fair.market.net >= 0 ? 'you' : partnerName}.
                    The market pays for stars and for names, the projections for production and games played: a trade between them is a bet that the
                    projections are right, and most managers will judge it the market&apos;s way.
                  </p>
                )}
                {settledNote && lenses?.settled && (
                  <p className="text-muted">
                    {lenses.settled.dropped.length > 0 && <>Your drop to make room ({nameList(lenses.settled.dropped)}) counts as given. </>}
                    {lenses.settled.added.length > 0 && <>The free agent you would pick up ({nameList(lenses.settled.added)}) counts as received.</>}
                  </p>
                )}
              </div>
            )}
            <p className={impact ? 'text-muted' : 'text-base'}>
              {impact ? 'In value: ' : ''}
              {fair?.even ? (
                <>About even for the {REST}.</>
              ) : (fair?.value.net ?? net) > 0 ? (
                <>
                  Favours you by <Signed value={fair?.value.net ?? net} digits={1} /> for the {REST}.
                </>
              ) : (
                <>
                  Favours your partner by <Signed value={-(fair?.value.net ?? net)} digits={1} /> for the {REST}.
                </>
              )}
            </p>
            <p className="text-muted">
              You give <Signed value={giving.value} digits={1} /> and get <Signed value={getting.value} digits={1} />:{' '}
              {week ? (
                <>
                  each player&apos;s last-ten form above a replacement-level player under your league&apos;s scoring, counted over the games left
                  this fantasy week (Monday to Sunday).
                </>
              ) : (
                <>
                  value above a replacement-level player under your league&apos;s scoring, counted over the games each player is expected to play
                  from today (injuries, return dates and the schedule included). Over the whole season it is{' '}
                  <Signed value={giving.season} digits={1} /> for <Signed value={getting.season} digits={1} />.
                </>
              )}
            </p>
            {weekAvailable && (
              <p className="text-muted" data-testid="trade-week-games">
                Games left this fantasy week: {giving.games} for the players you give, {getting.games} for the players you get.
              </p>
            )}
            {[...giving.belowReplacement, ...getting.belowReplacement].length > 0 && (
              <p className="text-muted" data-testid="trade-below-replacement">
                {[...giving.belowReplacement, ...getting.belowReplacement].map((p) => p.full_name ?? p.player_id).join(', ')}{' '}
                {[...giving.belowReplacement, ...getting.belowReplacement].length === 1 ? 'is' : 'are'} below replacement level and
                count as zero: a free agent would do as well, so a trade gains nothing by sending or taking{' '}
                {[...giving.belowReplacement, ...getting.belowReplacement].length === 1 ? 'that player' : 'them'}.
              </p>
            )}
            {spots !== 0 && !impact && (
              <p className="text-muted" data-testid="trade-spots">
                {spots > 0
                  ? `You receive ${spots} more player${spots === 1 ? '' : 's'} than you send, so you would drop ${spots}. A dropped player is worth about replacement level, which the values above already count as zero.`
                  : `You send ${-spots} more player${-spots === 1 ? '' : 's'} than you receive, freeing ${-spots} roster spot${-spots === 1 ? '' : 's'}. The best free agent fills each at about replacement level, so the values above already allow for it.`}
              </p>
            )}
            {punted.length > 0 && (
              <p className="text-muted" data-testid="trade-punts">
                Punting {punted.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}: values and categories leave {punted.length === 1 ? 'it' : 'them'} out
                (change the punts on the <a href={href('/league/')} className="underline underline-offset-4">League page</a> or the board).
              </p>
            )}
            {points && (
              <p className="text-muted">Your league scores points: the values are fantasy points per game above replacement, with your league&apos;s weights.</p>
            )}
              </div>
            </details>
          </div>
        </Card>
      )}

      {current === 'build' && ready && hasRosters && (
        <Card title="Suggested trades" id="suggestions" badge={<Unvalidated issue={887} what="The suggestions" />}>
          {standings && (
            <label className="mb-2 flex items-center gap-2 text-sm" title="Both teams' expected categories must rise">
              <input type="checkbox" checked={winWin} onChange={(e) => setWinWin(e.target.checked)} data-testid="win-win" />
              Win-win only
            </label>
          )}
          {suggestions.length ? (
            <>
              {/* A phone gets a stacked list, so each suggestion's button is on screen (#455); wider screens the table. */}
              <ul className="grid gap-2 text-sm md:hidden" data-testid="trade-suggestions-list">
                {suggestions.map((s) => (
                  <li key={`${s.give.join()}>${s.get.join()}`} className="grid gap-1 rounded border border-line p-2">
                    <p>
                      <span className="text-xs text-muted">You give </span>
                      {nameList(s.give)}
                    </p>
                    <p>
                      <span className="text-xs text-muted">You get </span>
                      {nameList(s.get)}
                    </p>
                    {s.effect && (
                      <p className="flex flex-wrap items-center gap-x-2">
                        <span className="text-xs text-muted">Your categories </span>
                        {effectCell(s.effect)}
                      </p>
                    )}
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>
                        <span className="text-xs text-muted">Value </span>
                        <Signed value={s.net} digits={1} />
                      </span>
                      {s.effect && (
                        <span>
                          <span className="text-xs text-muted">{partnerName} </span>
                          <Signed value={s.effect.partnerGain} digits={2} />
                        </span>
                      )}
                    </p>
                    <button type="button" className={`${button} justify-self-start`} onClick={() => applySuggestion(s)}>
                      Use this trade
                    </button>
                  </li>
                ))}
              </ul>
              <div className="table-scroll hidden overflow-auto md:block" tabIndex={0} role="region" aria-label="Suggested trades">
                <table className="w-full text-sm" data-testid="trade-suggestions">
                  <thead>
                    <tr>
                      <Th>You give</Th>
                      <Th>You get</Th>
                      {standings && <Th>Your categories</Th>}
                      {standings && <Th right>{partnerName}</Th>}
                      <Th right>Value</Th>
                      <Th>{''}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {suggestions.map((s) => (
                      <tr key={`${s.give.join()}>${s.get.join()}`} className="border-t border-line">
                        <Td>{nameList(s.give)}</Td>
                        <Td>{nameList(s.get)}</Td>
                        {standings && <Td>{s.effect ? effectCell(s.effect) : '–'}</Td>}
                        {standings && (
                          <Td right>
                            <Signed value={s.effect?.partnerGain ?? null} digits={2} />
                          </Td>
                        )}
                        <Td right>
                          <Signed value={s.net} digits={1} />
                        </Td>
                        <Td>
                          <button type="button" className={button} onClick={() => applySuggestion(s)}>
                            Use this trade
                          </button>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted" data-testid="trade-no-suggestions">
              {open === 'give' && !active(setup.mine).length
                ? 'Add your own roster on the League page to see what you could offer.'
                : open === 'get' && !active(partnerTeam).length
                  ? `Add ${setup.names[partnerTeam] ?? 'the partner'}’s roster on the League page to see what you could ask for.`
                  : standings
                    ? `No package of up to three players from ${open === 'give' ? 'your' : `${partnerName}’s`} roster raises your expected categories won on terms ${partnerName} could accept${winWin ? ' (win-win only: theirs must rise too)' : ''}. Try another partner, or a different player.`
                    : `No package of up to three players from ${open === 'give' ? 'your' : `${partnerName}’s`} roster comes within 15% of the other side for the ${REST}. Try another partner, or a different player.`}
            </p>
          )}
          <p className="mt-2 text-xs text-muted">
            {open === 'give' ? 'Packages from your roster' : `Packages from ${partnerName}’s roster`}
            {standings
              ? ` that raise the categories you expect to win, biggest gain first, among trades ${partnerName} could accept: ${winWin ? 'win-win only, so their expected categories rise too' : 'they give up at most 15% in value, or their own categories rise'}. The value can favour ${partnerName}; what counts is the categories. Your categories: the change in the categories you expect to win ${h2h ? 'a week' : '(rotisserie points)'}; ${partnerName}: theirs. Pick one to load it into the trade and see the full breakdown.`
              : ` that bring the two sides within 15% of each other for the ${REST}, the ones that favour you most first.${
                  points ? '' : ' Enter half or more of a second team’s roster on the League page to rank them by the categories they win you instead.'
                }`}
          </p>
        </Card>
      )}

      {current === 'build' && ready && !hasRosters && nearest.length > 0 && (
        <Card title="Players worth about the same" id="suggestions">
          <ul className="flex flex-wrap gap-1" data-testid="trade-nearest">
            {nearest.map(({ id, diff }) => (
              <li key={id}>
                <button type="button" className={`${button} flex items-center gap-1`} onClick={() => add(targetSide === 'get' ? 'give' : 'get', id)} title="Add to the trade">
                  {nameOf(id)} <Signed value={diff} digits={1} />
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            Players on the board worth about the same for the {REST} as {targetSide === 'get' ? 'what you get' : 'what you give'}, nearest first, with the
            difference. Tap one to put it on the other side. Set up your league&apos;s rosters to get packages from a partner&apos;s roster instead.
          </p>
        </Card>
      )}

      {current === 'build' && ready && (
        <details className="rounded-lg border border-line bg-card p-3" data-testid="trade-numbers">
          <summary className="cursor-pointer text-sm font-medium tracking-wide text-muted uppercase">
            The numbers: {points ? 'the players' : change ? 'the players and your categories' : 'the players and the categories'}
          </summary>
          {!points && (
            <div className="mt-2">
              <Segmented
                label="The numbers"
                value={numbers}
                options={[
                  { id: 'players', label: 'Players' },
                  { id: 'categories', label: change ? 'Your categories' : 'Categories' },
                ]}
                onChange={setNumbers}
              />
            </div>
          )}
          <div className={`mt-2 ${numbers === 'players' || points ? '' : 'hidden'}`} id="players">
          <div className="table-scroll overflow-auto" tabIndex={0} role="region" aria-label="The players">
            <table className="w-full text-sm" data-testid="trade-players">
              <thead>
                <tr>
                  <Th>Player</Th>
                  <Th>Team</Th>
                  <Th>Pos</Th>
                  <Th right>ESPN</Th>
                  {!points && <Th right>Form</Th>}
                  {!points && <Th>Strong · weak</Th>}
                  {!complete && <Th right>Games left</Th>}
                  {points && <Th right>FPts/G</Th>}
                  <Th right>Value/G</Th>
                  <Th right>Games share</Th>
                  <Th right>{complete ? 'Next season' : 'Season'}</Th>
                  {!complete && <Th right>Available</Th>}
                  {!complete && <Th right>Rest of season</Th>}
                  {weekAvailable && <Th right>Games this week</Th>}
                  {weekAvailable && <Th right>This week</Th>}
                </tr>
              </thead>
              <tbody>
                {giving.players.map(playerRow)}
                {totalRow('You give', giving, 'total-give')}
                {getting.players.map(playerRow)}
                {totalRow('You get', getting, 'total-get')}
              </tbody>
            </table>
          </div>
          {timing.length > 0 && (
            <ul className="mt-3 grid gap-1 text-sm" data-testid="trade-timing">
              {timing.map((n) => (
                <li key={n} className="flex gap-2">
                  <span aria-hidden="true">⏱</span>
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted">
            ESPN: where ESPN&apos;s drafters rank the player. Form: the last ten games against the projection, summed over your kept categories
            (hot or cold past {HOT}). Strong · weak: the player's best categories and worst. Value/G: value per game above your league&apos;s replacement level.
            Games share: the share of the season&apos;s games the player is projected to play.{' '}
            {complete
              ? 'The season is over: Next season counts those games under the projection.'
              : 'Available: the share of the remaining games the player is expected to play. Season and rest of season count those games.'}
          </p>
          </div>
          {!points && (
            <div className={`mt-2 ${numbers === 'categories' ? '' : 'hidden'}`} id="categories">
          <div className="table-scroll overflow-auto" tabIndex={0} role="region" aria-label="Category by category">
            <table className="w-full text-sm" data-testid="trade-categories">
              <thead>
                <tr>
                  <Th>Category</Th>
                  <Th right>You give</Th>
                  <Th right>You get</Th>
                  <Th right>Net</Th>
                  {change && <Th right>Your team before</Th>}
                  {change && <Th right>After</Th>}
                  {change && (impact ? <Th right>{h2h ? 'Win chance' : 'Teams beaten'}</Th> : <Th right>Rank of {change.ranked}</Th>)}
                  {change && impact && <Th right>{partnerName}&apos;s</Th>}
                </tr>
              </thead>
              <tbody>
                {cats.map((c) => {
                  const g = giving.cats[c] ?? 0;
                  const r = getting.cats[c] ?? 0;
                  const row = change?.rows.find((x) => x.c === c);
                  return (
                    <tr key={c} className="border-t border-line">
                      <Td>{CATEGORY_LABELS[c] ?? c}</Td>
                      <Td right>
                        <Signed value={g} />
                      </Td>
                      <Td right>
                        <Signed value={r} />
                      </Td>
                      <Td right>
                        <Signed value={r - g} />
                      </Td>
                      {row && (
                        <Td right>
                          <Signed value={impact ? (impact.totals.before[c] ?? 0) : row.before} digits={1} />
                        </Td>
                      )}
                      {row && (
                        <Td right>
                          <Signed value={impact ? (impact.totals.after[c] ?? 0) : row.after} digits={1} />
                        </Td>
                      )}
                      {row && impact && (
                        <Td right>
                          <span className={chanceTone(impact.mine.before[c] ?? 0, impact.mine.after[c] ?? 0)}>
                            {chance(impact.mine.before[c])}
                            {chance(impact.mine.after[c]) !== chance(impact.mine.before[c]) ? ` → ${chance(impact.mine.after[c])}` : ''}
                          </span>
                        </Td>
                      )}
                      {row && impact && (
                        <Td right>
                          <span className={chanceTone(impact.partner.before[c] ?? 0, impact.partner.after[c] ?? 0)}>
                            {chance(impact.partner.before[c])}
                            {chance(impact.partner.after[c]) !== chance(impact.partner.before[c]) ? ` → ${chance(impact.partner.after[c])}` : ''}
                          </span>
                        </Td>
                      )}
                      {row && !impact && (
                        <Td right>
                          <span className={rankTone(row.rankBefore, row.rankAfter)}>
                            {row.rankBefore}
                            {row.rankAfter !== row.rankBefore ? ` → ${row.rankAfter}` : ''}
                          </span>
                        </Td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">
            Per game above replacement in each category (percentages weighted by attempts).
            {impact
              ? ` Your team’s totals (each player counted by the share of the games left they are expected to play, after any drop or pickup) and your chance of ${
                  h2h ? 'winning the category in an average week against your league' : 'finishing ahead of each other team in it'
                }, before and after. A category you already lose or win by a wide margin barely moves; one you are close in can swing.`
              : change
                ? ' Your team’s totals and its rank among the league’s teams, before and after: a trade that drops a category you already lose costs little, and one that lifts a category you are close in can swing it.'
                : ' Set up your league’s rosters to see your team’s totals and ranks before and after.'}
          </p>
            </div>
          )}
        </details>
      )}
    </div>
  );
}
