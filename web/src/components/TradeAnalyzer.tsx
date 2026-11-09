/**
 * The Trade page: what each side of a trade is worth under the manager's league settings, how the
 * manager's team changes category by category, and a verdict. Players come from the league's
 * rosters when the League page has them, or from a search over the whole board.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { fetchBuildJson, type League } from '../lib/data';
import { CATEGORY_LABELS } from '../lib/format';
import { currentLeague } from '../lib/league';
import { categoryWeights, DEFAULT_SETTINGS, isDefaultSettings, owners, useLeague, weightedSum } from '../lib/fantasy-league';
import { acceptable, type FairnessModel, leagueState, marketMap, tradeLenses, type Worth } from '../lib/league-model';
import { bothBuilds, bothNeeds, partnerSide, worthUnder } from '../lib/trade-partner';
import { leagueValues, partnerSettings } from '../lib/valuation';
import { href } from '../lib/site';
import { matchup, weekTotals } from '../lib/matchup';
import { type LeagueState, leagueStandings, meaningful, objective, rostersAfter, tradeImpact } from '../lib/trade-impact';
import { median, ranks, tradeChips, tradeTargets } from '../lib/punt-chips';
import { buySell } from '../lib/buy-sell';
import { rivals } from '../lib/standings';
import { judge } from '../lib/trade-fairness';
import { type CategoryEffect, findTrades, type FoundTrade, nearestInValue, openSide, type Suggestion, suggestTrades } from '../lib/trade-suggest';
import { NO_WORTH, teamChange, timingNotes, type TradePlayer, tradeSide } from '../lib/trade-players';
import { hasWeekGames, type ValueUnit } from '../lib/week-value';
import { SHOWS, showsBuyLow } from '../lib/visibility';
import { BuySellCard } from './BuySellCard';
import { describeSettings } from './LeagueParts';
import { useEspnSync } from './LeagueSync';
import { PlayerPicker } from './PlayerPicker';
import ExplainTrade from './ExplainTrade';
import { TradeCategoryBreakdown } from './TradeCategoryBreakdown';
import { TradeChips } from './TradeChips';
import { TradeFinder } from './TradeFinder';
import { TradeNumbers } from './TradeNumbers';
import { button } from './TradeParts';
import { TradeScorecard } from './TradeScorecard';
import { TradeSuggestions } from './TradeSuggestions';
import { TradeValueBreakdown } from './TradeValueBreakdown';
import { Card, Loading, Problem, Segmented, Signed, Unvalidated } from './ui';

/** The board's rows, as the Trade page reads them (trade-players.ts). */
type PlayerRow = TradePlayer;

/** A player's worth under the league's settings (league-model.ts). */
type Value = Worth;

type Side = 'give' | 'get';

const input = 'rounded border border-line bg-bg px-2 py-1 text-sm';

const optionLabel = (p: PlayerRow) => `${p.full_name ?? p.player_id} · ${p.team_abbreviation ?? 'FA'} · ${p.position ?? '–'}`;


/** The figure a trade is judged on, as a short label: the rest of the season, or this fantasy week (#466). */
const UNIT_TEXT: Record<ValueUnit, string> = { rest: 'rest of season', week: 'rest of this fantasy week' };

/** The page's three tools (#720): build a trade, find one across the league, or start from the build's chips and targets. */
type Tab = 'build' | 'find' | 'chips';

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
  // The kept categories each count once; punted ones not at all (#661).
  const catWeight = useMemo(() => categoryWeights(setup), [setup]);
  const punted = points ? [] : setup.punts;
  // The week unit is offered while the week has games left; it re-measures the categories on last-ten form.
  const weekAvailable = useMemo(() => !!rows && hasWeekGames(rows), [rows]);
  const week = unit === 'week' && weekAvailable;
  // After the last game the season's value is the projection for the next one (#450).
  const complete = !!rows?.length && rows.every((r) => r.season_complete);
  const REST = week ? UNIT_TEXT.week : complete ? 'next season' : UNIT_TEXT.rest;

  // The partner defaults to the first team that is not the manager's.
  const partnerTeam = partner ?? setup.names.findIndex((_, i) => i !== setup.mine);

  // Each player's worth under the league's settings and the manager's punts (valuation.ts, #938);
  // `cats` are the kept categories: a punted one counts for nothing in a trade (#661).
  const { worth, cats, values } = useMemo(() => worthUnder(rows ?? [], setup), [rows, setup]);
  // The values under every category the league scores: the partner's build (#938), and how the rest of the league ranks a player.
  const everyCat = useMemo(() => (rows ? leagueValues(rows, partnerSettings(setup)) : null), [rows, setup]);

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
  // The partner's side under the partner's own build (#938): every category the league scores.
  const theirs = useMemo(
    () => (rows && state && punted.length ? partnerSide(rows, { league, setup, owner, partner: partnerTeam, week }) : null),
    [rows, state, punted.length, league, setup, owner, partnerTeam, week],
  );
  const partnerWorth = theirs?.worth ?? worth;
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
    const recent = values.recentCats;
    const mine = (setup.rosters[setup.mine] ?? []).filter((id) => !setup.il.includes(id));
    const projected = (id: string) => worth.get(id)?.perGame ?? 0;
    return buySell({
      league,
      mine: setup.mine,
      owner: new Map([...owner].filter(([id]) => !setup.il.includes(id))),
      projected,
      recent: (id) => weightedSum(recent?.get(id), catWeight),
      healthy: (id) => !['out', 'doubtful'].includes(byId.get(id)?.injury_group ?? ''),
      // good enough to start for you: at least your median player's projection
      startLine: median(mine.map(projected)),
    });
  }, [league, rows, points, hasRosters, setup.rosters, setup.mine, setup.il, values, owner, worth, catWeight, byId]);

  const chipsAndTargets = useMemo(() => {
    if (!rows || points || !hasRosters || !punted.length || !everyCat) return null;
    const allValue = everyCat.restValue;
    const ids = rows.map((r) => r.player_id);
    const league = ranks(ids, (id) => allValue.get(id) ?? 0);
    const build = ranks(ids, (id) => worth.get(id)?.rest ?? 0);
    const mine = (setup.rosters[setup.mine] ?? []).filter((id) => !setup.il.includes(id));
    const elsewhere = setup.rosters.flatMap((r, t) => (t === setup.mine ? [] : r.filter((id) => !setup.il.includes(id))));
    return {
      chips: tradeChips(mine, league, build, { pool, minGap: setup.teams }),
      targets: tradeTargets(elsewhere, league, build, { ceiling: median(mine.map((id) => build.get(id) ?? Infinity)), minGap: setup.teams }),
    };
  }, [rows, points, hasRosters, punted, everyCat, setup.rosters, setup.mine, setup.il, setup.teams, pool, worth]);

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
  const pick = (w: Value) => (week ? w.week : w.rest);
  const giving = tradeSide(give, byId, worth, cats, week);
  const getting = tradeSide(get, byId, worth, cats, week);
  const net = getting.value - giving.value;
  const scale = Math.max(Math.abs(giving.value), Math.abs(getting.value), 1);
  const spots = getting.players.length - giving.players.length;

  // The manager's team before and after, with its rank in each category among the league's teams.
  const myRoster = hasRosters ? (setup.rosters[setup.mine] ?? []) : null;
  const change =
    !myRoster || points
      ? null
      : teamChange({ rosters: setup.rosters, mine: setup.mine, partner: partnerTeam, il: setup.il, give, get, cats, worth });

  // Suggestions: packages from the open side's roster that make the trade about even, ranked by the
  // category ranks they gain the manager; without rosters, players worth about the same as the target.
  const ready = giving.players.length > 0 || getting.players.length > 0;
  // What the trade does to both teams' categories (#663); null without the standings.
  const impact = state && standings && ready && partnerTeam >= 0 ? bothBuilds(state, standings, theirs, setup.mine, partnerTeam, give, get) : null;
  // What the partner gives up and gets, valued under the partner's build
  const partnerValue = tradeSide(give, byId, partnerWorth, theirs?.cats ?? cats, week).value - tradeSide(get, byId, partnerWorth, theirs?.cats ?? cats, week).value;
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
  const needs = impact && state && standings ? bothNeeds(state, standings, theirs, setup.mine, partnerTeam) : null;
  const verdictBoth = impact && state ? objective(impact.mine.gain, impact.partner.gain, threshold) : null;

  // This week's matchup before and after (#674): a head-to-head league with an opponent set and
  // games left this week, on the projected line over the games left, as the board's matchup card.
  const opponent = h2h && setup.opponent !== null && weekAvailable && state ? setup.opponent : null;
  const weekMatch = (() => {
    if (opponent === null || !state || !ready) return null;
    const rowsOf = (ids: string[]) => ids.map((id) => byId.get(id)).filter((p): p is PlayerRow => !!p);
    const sides = rostersAfter(state, setup.mine, partnerTeam, give, get);
    const theirs = state.rosters[opponent] ?? [];
    const before = matchup(league, cats, weekTotals(rowsOf(state.rosters[setup.mine] ?? []), cats), weekTotals(rowsOf(theirs), cats));
    const after = matchup(
      league,
      cats,
      weekTotals(rowsOf(sides.mine.after), cats),
      weekTotals(rowsOf(opponent === partnerTeam ? sides.partner.after : theirs), cats),
    );
    const flips = after.cats.filter((r) => r.result !== before.cats.find((b) => b.cat === r.cat)?.result);
    return { before, after, flips, name: setup.names[opponent] ?? 'your opponent' };
  })();
  const restOf = new Map([...worth].map(([id, w]) => [id, Math.max(0, pick(w))]));
  const active = (t: number) => (setup.rosters[t] ?? []).filter((id) => !setup.il.includes(id));
  const open = openSide(give, get, restOf);
  const suggestions =
    SHOWS.tradeSuggestions && ready && hasRosters && partnerTeam >= 0
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
  const nearest = SHOWS.tradeSuggestions && ready && !hasRosters ? nearestInValue(targetSide === 'get' ? get : give, restOf, [...give, ...get]) : [];
  const nameOf = (id: string) => byId.get(id)?.full_name ?? id;
  const nameList = (ids: string[]) => ids.map(nameOf).join(' + ');
  const applySuggestion = (s: Suggestion) => {
    setGive(s.give);
    setGet(s.get);
  };
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
      .sort((a, b) => pick(worth.get(b.player_id) ?? NO_WORTH) - pick(worth.get(a.player_id) ?? NO_WORTH));
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
              <span className="w-12 text-right tabular-nums"><Signed value={pick(worth.get(p.player_id) ?? NO_WORTH)} digits={1} /></span>
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

  // More of each player than his value (#694): when his form or an injury makes the timing good or bad.
  const timing = timingNotes(giving.players, getting.players, cats, points);

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

  // only the calls that passed their check show (#936): buy low in an NBA league (ADR 0027); sell high
  // (#903), buy low in the WNBA (#904), the chips (#896) and the finder (#888) failed
  const shown = swings ? { ...swings, buyLow: showsBuyLow(league) ? swings.buyLow : [], sellHigh: SHOWS.sellHigh ? swings.sellHigh : [] } : null;
  const hasChips = SHOWS.tradeChips && !!chipsAndTargets && (chipsAndTargets.chips.length > 0 || chipsAndTargets.targets.length > 0);
  const hasSwings = !!shown && (shown.buyLow.length > 0 || shown.sellHigh.length > 0);
  const tabs: { id: Tab; label: string; title: string }[] = [
    { id: 'build', label: 'Build', title: 'Pick the players each side gives and see what the trade does' },
    ...(SHOWS.tradeFinder && standings ? [{ id: 'find' as const, label: 'Find', title: 'Trades across your league that win you categories' }] : []),
    ...(hasChips || hasSwings
      ? [
          SHOWS.sellHigh || hasChips
            ? { id: 'chips' as const, label: 'Buy & sell', title: 'Players to buy low and sell high on form, and the chips and targets your punts make' }
            : { id: 'chips' as const, label: 'Buy low', title: 'Players elsewhere in a slump, who would start for you' },
        ]
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

      {current === 'find' && SHOWS.tradeFinder && standings && (
        <TradeFinder
          found={found}
          winWin={winWin}
          onWinWin={setWinWin}
          onFind={() => setFinding(true)}
          names={setup.names}
          nameList={nameList}
          h2h={h2h}
          onUse={(t) => {
            setPartner(t.partner);
            setGive(t.give);
            setGet(t.get);
            setTab('build');
          }}
        />
      )}

      {current === 'chips' && shown && hasSwings && (
        <BuySellCard
          swings={shown}
          sellHigh={SHOWS.sellHigh}
          league={league}
          nameOf={nameOf}
          teamName={(team) => setup.names[team] ?? null}
          onOffer={(id) => {
            add('give', id);
            setTab('build');
          }}
          onAskFor={(team, id) => {
            setPartner(team);
            add('get', id);
            setTab('build');
          }}
        />
      )}

      {current === 'chips' && hasChips && (
        <TradeChips
          chips={chipsAndTargets.chips}
          targets={chipsAndTargets.targets}
          punted={punted}
          teams={setup.teams}
          nameOf={nameOf}
          ownerName={(id) => setup.names[owner.get(id) ?? -1] ?? ''}
          onOffer={(id) => {
            add('give', id);
            setTab('build');
          }}
          onAskFor={(id) => {
            const t = owner.get(id);
            if (t !== undefined) setPartner(t);
            add('get', id);
            setTab('build');
          }}
        />
      )}

      {current === 'build' && ready && (
        <Card
          title={SHOWS.tradeVerdict ? 'Verdict' : 'What the trade does'}
          id="verdict"
          badge={SHOWS.tradeVerdict ? <Unvalidated issue={886} what="The trade verdict" /> : undefined}
        >
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
              <TradeScorecard
                fair={fair}
                impact={impact}
                needs={needs}
                objective={SHOWS.tradeVerdict ? verdictBoth : null}
                calls={SHOWS.tradeVerdict}
                partnerName={partnerName}
                h2h={h2h}
                nameList={nameList}
                threshold={threshold}
              />
            )}
            {SHOWS.explainTrade && aiFacts && <ExplainTrade facts={aiFacts} />}
            <details className="rounded-lg border border-line p-2" data-testid="trade-details">
              <summary className="cursor-pointer text-sm font-medium">The full breakdown: how this is worked out</summary>
              <div className="mt-2 grid gap-2">
            {impact && (
              <TradeCategoryBreakdown
                impact={impact}
                threshold={threshold}
                h2h={h2h}
                catCount={cats.length}
                verdictBoth={SHOWS.tradeVerdict ? verdictBoth : null}
                calls={SHOWS.tradeVerdict}
                partnerName={partnerName}
                nameList={nameList}
                weekMatch={weekMatch}
                partnerValue={partnerValue}
                partnerCats={points ? null : (theirs?.cats ?? cats).length}
                scale={scale}
                needs={needs}
                marketGive={market(give)}
                marketGet={market(get)}
              />
            )}
            <TradeValueBreakdown
              fair={fair}
              calls={SHOWS.tradeVerdict}
              settled={settledNote ? (lenses?.settled ?? null) : null}
              partnerName={partnerName}
              nameList={nameList}
              hasImpact={!!impact}
              net={net}
              rest={REST}
              giving={giving}
              getting={getting}
              week={week}
              weekAvailable={weekAvailable}
              spots={spots}
              punted={punted}
              points={points}
            />
              </div>
            </details>
          </div>
        </Card>
      )}

      {current === 'build' && ready && hasRosters && SHOWS.tradeSuggestions && (
        <TradeSuggestions
          suggestions={suggestions}
          byStandings={!!standings}
          winWin={winWin}
          onWinWin={setWinWin}
          nameList={nameList}
          partnerName={partnerName}
          partnerRoster={setup.names[partnerTeam] ?? 'the partner'}
          open={open}
          mineEmpty={!active(setup.mine).length}
          theirsEmpty={!active(partnerTeam).length}
          rest={REST}
          h2h={h2h}
          points={points}
          onUse={applySuggestion}
        />
      )}

      {current === 'build' && ready && !hasRosters && SHOWS.tradeSuggestions && nearest.length > 0 && (
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
        <TradeNumbers
          league={league}
          points={points}
          complete={complete}
          weekAvailable={weekAvailable}
          cats={cats}
          worth={worth}
          giving={giving}
          getting={getting}
          timing={timing}
          numbers={numbers}
          onNumbers={setNumbers}
          change={change}
          impact={impact}
          h2h={h2h}
          partnerName={partnerName}
        />
      )}
    </div>
  );
}
