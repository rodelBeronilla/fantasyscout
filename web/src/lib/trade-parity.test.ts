import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { acceptable, type FairnessModel, tradeLenses } from './league-model';
import { rivals } from './standings';
import { judge, marketValues } from './trade-fairness';
import { type LeagueState, leagueStandings, meaningful, objective, teamNeeds, tradeImpact } from './trade-impact';
import { type CategoryEffect, findTrades, suggestTrades } from './trade-suggest';

interface TradeCase {
  name: string;
  league: 'nba' | 'wnba';
  format: 'h2h' | 'roto';
  cats: string[];
  rosters: string[][];
  rosterSpots: number;
  freeAgents: string[];
  mine: number;
  gamesLeft: number;
  values: Record<string, Record<string, number>>;
  rest: Record<string, number>;
  availability: Record<string, number>;
  marketRank: Record<string, number>;
  trades: { partner: number; give: string[]; get: string[] }[];
  suggest: { partner: number; give: string[]; get: string[] }[];
}

interface ParityFixture {
  cases: TradeCase[];
  expected?: unknown;
}

const listed = (t: { give: string[]; get: string[]; net: number; effect: CategoryEffect | null; partner?: number }) => ({
  ...(t.partner === undefined ? {} : { partner: t.partner }),
  give: t.give,
  get: t.get,
  net: t.net,
  gain: t.effect?.gain ?? null,
  partnerGain: t.effect?.partnerGain ?? null,
});

function compute(c: TradeCase) {
  const state: LeagueState = {
    league: c.league,
    format: c.format,
    cats: c.cats,
    rosters: c.rosters,
    rosterSpots: c.rosterSpots,
    freeAgents: c.freeAgents,
    rest: (id) => c.rest[id] ?? 0,
    catValue: (id) => c.values[id],
    availability: (id) => c.availability[id] ?? 1,
    gamesLeft: c.gamesLeft,
  };
  const standings = leagueStandings(state, c.mine)!;
  const ids = [...c.rosters.flat(), ...c.freeAgents];
  const market = marketValues(
    ids.map((id) => ({ player_id: id, market_rank: c.marketRank[id] ?? null })),
    (id) => c.rest[id] ?? 0,
  );
  const fairness: FairnessModel = { league: c.league, state, mine: c.mine, value: (id) => c.rest[id] ?? 0, market, ranked: (id) => id in c.marketRank };
  const threshold = meaningful(state, c.mine);
  const effect = (partner: number) => (g: string[], r: string[]): CategoryEffect => {
    const e = tradeImpact(state, standings, c.mine, partner, g, r);
    return { gain: e.mine.gain, partnerGain: e.partner.gain, ups: e.ups, downs: e.downs };
  };
  const floored = new Map(ids.map((id) => [id, Math.max(0, c.rest[id] ?? 0)]));
  const finder = (winWin: boolean) =>
    findTrades({
      mine: c.rosters[c.mine] ?? [],
      partners: rivals(c.rosters, c.mine, c.rosterSpots).map((team) => ({ team, roster: c.rosters[team] ?? [] })),
      rest: floored,
      effect: (team, g, r) => effect(team)(g, r),
      minGain: threshold,
      winWin,
      acceptable: (team, g, r) => acceptable(fairness, team, g, r),
    }).map(listed);
  const suggest = (s: TradeCase['suggest'][number], winWin: boolean, model: boolean) =>
    suggestTrades({
      give: s.give,
      get: s.get,
      mine: c.rosters[c.mine] ?? [],
      theirs: c.rosters[s.partner] ?? [],
      rest: floored,
      effect: model ? effect(s.partner) : undefined,
      minGain: threshold,
      winWin,
      acceptable: (g, r) => acceptable(fairness, s.partner, g, r),
    }).map(listed);
  return {
    spread: standings.model.spread,
    totals: standings.totals,
    market: Object.fromEntries(market),
    threshold,
    needs: teamNeeds(state, standings, c.mine),
    trades: c.trades.map((t) => {
      const impact = tradeImpact(state, standings, c.mine, t.partner, t.give, t.get);
      const lenses = tradeLenses(fairness, t.partner, t.give, t.get);
      const fair = judge(lenses.value, lenses.market, impact.mine.gain, threshold, c.league);
      return {
        mine: { scoreBefore: impact.mine.scoreBefore, scoreAfter: impact.mine.scoreAfter, gain: impact.mine.gain },
        partner: { scoreBefore: impact.partner.scoreBefore, scoreAfter: impact.partner.scoreAfter, gain: impact.partner.gain },
        sides: impact.sides,
        ups: impact.ups,
        downs: impact.downs,
        partnerUps: impact.partnerUps,
        partnerDowns: impact.partnerDowns,
        value: lenses.value,
        market: lenses.market,
        verdict: { even: fair.even, severity: fair.severity, reasons: fair.reasons.length, disagree: fair.disagree },
        acceptable: acceptable(fairness, t.partner, t.give, t.get),
        objective: objective(impact.mine.gain, impact.partner.gain, threshold),
      };
    }),
    finder: { winWin: finder(true), any: finder(false) },
    suggest: c.suggest.map((s) => ({ winWin: suggest(s, true, true), any: suggest(s, false, true), points: suggest(s, false, false) })),
  };
}

// The Python reference (ops/trade.py) runs the backtest (#756); both are checked against the same
// figures. UPDATE_TRADE_PARITY=1 rewrites them from these modules after a deliberate change.
describe('parity with ops/trade.py (#756)', () => {
  const path = fileURLToPath(new URL('../../../tests/fixtures/trade_parity.json', import.meta.url));
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as ParityFixture;
  const computed = { cases: fixture.cases.map(compute) };
  if (process.env['UPDATE_TRADE_PARITY']) writeFileSync(path, `${JSON.stringify({ ...fixture, expected: computed }, null, 1)}\n`);

  it('gives the figures the Python reference is checked against', () => {
    expect(fixture.expected).toBeDefined();
    const close = (a: unknown, b: unknown): void => {
      if (typeof a === 'number' && typeof b === 'number') expect(a).toBeCloseTo(b, 12);
      else if (a && typeof a === 'object' && b && typeof b === 'object') {
        expect(Object.keys(a)).toEqual(Object.keys(b));
        for (const k of Object.keys(a)) close((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]);
      } else expect(a).toEqual(b);
    };
    close(computed, fixture.expected);
  });

  it('exercises every verdict and both finder rules', () => {
    const all = computed.cases.flatMap((c) => c.trades);
    expect(new Set(all.map((t) => t.verdict.severity)).size).toBeGreaterThan(1);
    expect(all.some((t) => t.sides.mine.dropped.length || t.sides.partner.dropped.length)).toBe(true);
    expect(computed.cases.some((c) => c.finder.any.length > 0)).toBe(true);
  });
});
