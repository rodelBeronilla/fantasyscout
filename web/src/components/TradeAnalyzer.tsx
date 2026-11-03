/**
 * The Trade page: what each side of a trade is worth under the manager's league settings, how the
 * manager's team changes category by category, and a verdict. Players come from the league's
 * rosters when the League page has them, or from a search over the whole board.
 */
import { useEffect, useMemo, useState } from 'react';

import { fetchBuildJson, type League } from '../lib/data';
import { CATEGORY_LABELS, fmt, pct } from '../lib/format';
import { currentLeague } from '../lib/league';
import { categoryWeights, DEFAULT_SETTINGS, FOCUS_WEIGHT, isDefaultSettings, keptCategories, owners, useLeague, weightedSum } from '../lib/fantasy-league';
import { categoryValues, pointValues, scaleValue } from '../lib/league-value';
import { href } from '../lib/site';
import { matchup, weekTotals } from '../lib/matchup';
import { type LeagueState, leagueStandings, meaningful, objective, rostersAfter, teamNeeds, tradeImpact } from '../lib/trade-impact';
import { median, ranks, tradeChips, tradeTargets } from '../lib/punt-chips';
import { rivals } from '../lib/standings';
import { type CategoryEffect, findTrades, type FoundTrade, nearestInValue, openSide, type Suggestion, suggestTrades } from '../lib/trade-suggest';
import { hasWeekGames, recentForm, type ValueUnit, weekValue } from '../lib/week-value';
import { describeSettings } from './LeagueParts';
import { PlayerPicker } from './PlayerPicker';
import { Card, InjuryTag, injuryDetail, Loading, Problem, Segmented, Signed, Td, Th } from './ui';
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

/** A player's worth under the league's settings: per game, over the season, for the rest of it, and for this fantasy week. */
interface Value {
  perGame: number;
  season: number;
  rest: number;
  week: number;
  cats: Record<string, number>;
  fpts: number | null;
}

type Side = 'give' | 'get';

const input = 'rounded border border-line bg-bg px-2 py-1 text-sm';
const button = 'rounded border border-line px-2 py-1 text-xs hover:bg-bg disabled:opacity-50';

const optionLabel = (p: PlayerRow) => `${p.full_name ?? p.player_id} · ${p.team_abbreviation ?? 'FA'} · ${p.position ?? '–'}`;


/** The figure a trade is judged on, as a short label: the rest of the season, or this fantasy week (#466). */
const UNIT_TEXT: Record<ValueUnit, string> = { rest: 'rest of season', week: 'rest of this fantasy week' };

export default function TradeAnalyzer() {
  const [league] = useState<League>(() => currentLeague());
  const [rows, setRows] = useState<PlayerRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [setup] = useLeague(league);
  const [give, setGive] = useState<string[]>([]);
  const [get, setGet] = useState<string[]>([]);
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

  const owner = useMemo(() => owners(setup), [setup]);
  const hasRosters = owner.size > 0;
  const byId = useMemo(() => new Map((rows ?? []).map((r) => [r.player_id, r])), [rows]);
  const pool = setup.teams * setup.rosterSpots;
  const points = setup.scoring === 'points';
  // The league's categories less its punts (#661): a punted category counts for nothing in a trade.
  const cats = useMemo(() => keptCategories(setup), [setup]);
  // A focus category counts more in value and in judging a trade (#680).
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
    () => (rows && !points && week ? categoryValues(recentForm(rows, cats), cats, pool, setup.teams) : null),
    [rows, points, week, cats, pool, setup.teams],
  );

  // The partner defaults to the first team that is not the manager's.
  const partnerTeam = partner ?? setup.names.findIndex((_, i) => i !== setup.mine);

  const worth = useMemo(() => {
    const out = new Map<string, Value>();
    for (const r of rows ?? []) {
      const c: Record<string, number> = {};
      if (catValues) for (const k of cats) c[k] = catValues.get(r.player_id)?.[k] ?? 0;
      const pv = pointVals?.get(r.player_id);
      const perGame = points ? (pv?.value ?? 0) : weightedSum(c, catWeight);
      const season = scaleValue(perGame, r, { restOfSeason: false });
      const rest = scaleValue(perGame, r);
      const recent = points ? perGame : weightedSum(recentCats?.get(r.player_id), catWeight);
      out.set(r.player_id, { perGame, season, rest, week: weekValue(recent, r.games_this_week), cats: c, fpts: pv ? pv.fpts : null });
    }
    return out;
  }, [rows, catValues, pointVals, points, cats, recentCats, catWeight]);

  const options = useMemo(() => new Map((rows ?? []).map((p) => [optionLabel(p), p.player_id])), [rows]);

  // The league as the standings model reads it (#663, ADR 0015): active rosters, free agents best
  // first, each player's category values and the share of the games left he is expected to play.
  // A categories league with rosters in only; the standings also need a rival roster.
  const state = useMemo<LeagueState | null>(() => {
    if (!rows || points || !hasRosters) return null;
    const availability = new Map(rows.map((r) => [r.player_id, r.availability_multiplier ?? 1]));
    const value = (id: string) => {
      const w = worth.get(id);
      return w ? (week ? w.week : w.rest) : 0;
    };
    return {
      league,
      format: setup.format,
      cats,
      rosters: setup.rosters.map((r) => r.filter((id) => !setup.il.includes(id))),
      rosterSpots: setup.rosterSpots,
      freeAgents: rows
        .filter((r) => !owner.has(r.player_id))
        .map((r) => r.player_id)
        .sort((a, b) => value(b) - value(a)),
      rest: value,
      catValue: (id) => worth.get(id)?.cats,
      availability: (id) => availability.get(id) ?? 1,
      gamesLeft: rows.reduce((m, r) => Math.max(m, r.games_remaining ?? 0), 0),
      focus: catWeight,
    };
  }, [rows, points, hasRosters, worth, week, league, setup.format, setup.rosters, setup.il, setup.rosterSpots, cats, owner, catWeight]);
  const standings = useMemo(() => (state ? leagueStandings(state, setup.mine) : null), [state, setup.mine]);

  // Trade chips and targets for a punt build (#671): where each player ranks on rest-of-season value
  // over every category the league counts (roughly where other managers see him) against where he
  // ranks over the kept ones (where the build does). A gap of a round or more counts.
  const chipsAndTargets = useMemo(() => {
    if (!rows || points || !hasRosters || !punted.length) return null;
    const counted = keptCategories({ scoring: setup.scoring, punts: [] });
    const everyCat = categoryValues(rows, counted, pool, setup.teams);
    const allValue = new Map(
      rows.map((r) => [r.player_id, scaleValue(counted.reduce((s, c) => s + (everyCat.get(r.player_id)?.[c] ?? 0), 0), r)]),
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
        return { gain: e.mine.weightedGain, partnerGain: e.partner.gain, ups: e.ups, downs: e.downs };
      },
      minGain: meaningful(state, setup.mine),
      winWin,
      position: (id) => byId.get(id)?.position,
    });
  }, [finding, state, standings, worth, week, setup.mine, byId, winWin]);

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
  const verdict = Math.abs(net) < 0.05 * scale ? 'even' : net > 0 ? 'you' : 'partner';
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
  // Both sides in the same depth (#682): each team's needs from the standings, and the trade
  // judged by both teams' change in expected categories.
  const needs = impact && state && standings ? { mine: teamNeeds(state, standings, setup.mine), partner: teamNeeds(state, standings, partnerTeam) } : null;
  const verdictBoth = impact && state ? objective(impact.mine.weightedGain, impact.partner.gain, threshold) : null;

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
                  return { gain: e.mine.weightedGain, partnerGain: e.partner.gain, ups: e.ups, downs: e.downs };
                }
              : undefined,
          minGain: threshold || undefined,
          winWin,
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

  const playerRow = (p: PlayerRow) => {
    const w = worth.get(p.player_id);
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

      <div className="grid gap-6 md:grid-cols-2">
        {sideCard('give', 'You give', hasRosters ? setup.mine : null, give)}
        {sideCard('get', 'You get', hasRosters ? partnerTeam : null, get)}
      </div>

      {!ready && standings && (
        <Card title="Trades across your league" id="finder">
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

      {!ready && chipsAndTargets && (chipsAndTargets.chips.length > 0 || chipsAndTargets.targets.length > 0) && (
        <Card title="Trade chips and targets for your punt" id="chips">
          <p className="mb-3 text-sm text-muted">
            Punting {punted.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}, you rank players differently from the rest of your league. For you: the
            player&apos;s rank on value over the categories you keep. On value: his rank over every category, roughly where other managers see him.
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
                      <button type="button" className={button} onClick={() => add('give', v.id)}>
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
            more. A chip is a player to sell: other managers pay for categories you do not use. A target is one to buy for less than he is worth to you,
            among players who would start for you (ranked for you at least as high as your median player).
          </p>
        </Card>
      )}

      {ready && (
        <Card title="Verdict" id="verdict">
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
            {impact && (
              <div className="grid gap-1" data-testid="trade-category-verdict">
                <p className="text-base">
                  <strong>
                    {impact.mine.weightedGain >= threshold ? 'Wins you categories' : impact.mine.weightedGain <= -threshold ? 'Costs you categories' : 'About even in categories'}:
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
                          : 'Neither team gains categories.'}
                  </p>
                )}
                {(impact.ups.length > 0 || impact.downs.length > 0) && <p>{catMoves(impact.ups, impact.downs)}</p>}
                {setup.focus.length > 0 && (
                  <p className="text-muted" data-testid="trade-focus">
                    Counting your focus ({setup.focus.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}) {FOCUS_WEIGHT}×:{' '}
                    <Signed value={impact.mine.weightedGain} digits={2} />.
                  </p>
                )}
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
            <p className={impact ? 'text-muted' : 'text-base'}>
              {impact ? 'In value: ' : ''}
              {verdict === 'even' ? (
                <>About even: the two sides are within 5% of each other for the {REST}.</>
              ) : verdict === 'you' ? (
                <>
                  Favours you by <Signed value={net} digits={1} /> for the {REST}.
                </>
              ) : (
                <>
                  Favours your partner by <Signed value={-net} digits={1} /> for the {REST}.
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
                {[...giving.belowReplacement, ...getting.belowReplacement].length === 1 ? 'him' : 'them'}.
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
        </Card>
      )}

      {ready && hasRosters && (
        <Card title="Suggested trades" id="suggestions">
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

      {ready && !hasRosters && nearest.length > 0 && (
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

      {ready && (
        <Card title="The players" id="players">
          <div className="table-scroll overflow-auto" tabIndex={0} role="region" aria-label="The players">
            <table className="w-full text-sm" data-testid="trade-players">
              <thead>
                <tr>
                  <Th>Player</Th>
                  <Th>Team</Th>
                  <Th>Pos</Th>
                  {points && <Th right>FPts/G</Th>}
                  <Th right>Value/G</Th>
                  <Th right>Games share</Th>
                  <Th right>{complete ? 'Next season' : 'Season'}</Th>
                  {!complete && <Th right>Available</Th>}
                  {!complete && <Th right>Rest of season</Th>}
                  {weekAvailable && <Th right>Games left</Th>}
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
          <p className="mt-2 text-xs text-muted">
            Value/G: value per game above your league&apos;s replacement level. Games share: the share of the season&apos;s games the player is projected to
            play.{' '}
            {complete
              ? 'The season is over: Next season counts those games under the projection.'
              : 'Available: the share of the remaining games the player is expected to play. Season and rest of season count those games.'}
          </p>
        </Card>
      )}

      {ready && !points && (
        <Card title={change ? 'Your team, category by category' : 'Category by category'} id="categories">
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
              ? ` Your team’s totals (each player counted by the share of the games left he is expected to play, after any drop or pickup) and your chance of ${
                  h2h ? 'winning the category in an average week against your league' : 'finishing ahead of each other team in it'
                }, before and after. A category you already lose or win by a wide margin barely moves; one you are close in can swing.`
              : change
                ? ' Your team’s totals and its rank among the league’s teams, before and after: a trade that drops a category you already lose costs little, and one that lifts a category you are close in can swing it.'
                : ' Set up your league’s rosters to see your team’s totals and ranks before and after.'}
          </p>
        </Card>
      )}
    </div>
  );
}
