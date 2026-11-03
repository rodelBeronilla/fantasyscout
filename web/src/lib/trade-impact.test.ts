import { describe, expect, it } from 'vitest';

import { type LeagueState, leagueStandings, objective, rostersAfter, teamNeeds, tradeImpact } from './trade-impact';

const values: Record<string, Record<string, number>> = {
  // the manager: a scorer who does nothing for the kept categories, and two bigs
  scorer: { z_rebounds_total: -0.5, z_blocks: -0.3 },
  big1: { z_rebounds_total: 1, z_blocks: 1 },
  big2: { z_rebounds_total: 0.8, z_blocks: 0.6 },
  // the partner: a rebounder worth less overall, and a guard
  boards: { z_rebounds_total: 1.5, z_blocks: 0.8 },
  guard: { z_rebounds_total: -0.2, z_blocks: -0.2 },
  filler: { z_rebounds_total: 0, z_blocks: 0 },
  // a third team, and the free agents
  t1: { z_rebounds_total: 1, z_blocks: 0.5 },
  t2: { z_rebounds_total: 0.5, z_blocks: 0.5 },
  t3: { z_rebounds_total: 0.5, z_blocks: 0.5 },
  fa1: { z_rebounds_total: 0.2, z_blocks: 0.1 },
  fa2: { z_rebounds_total: 0.1, z_blocks: 0 },
};
const rest: Record<string, number> = { scorer: 6, big1: 4, big2: 3, boards: 3, guard: 2, filler: 0.5, t1: 4, t2: 3, t3: 3, fa1: 0.4, fa2: 0.2 };

const state: LeagueState = {
  league: 'nba',
  format: 'h2h',
  // a manager punting points, threes and assists keeps rebounds and blocks (here)
  cats: ['z_rebounds_total', 'z_blocks'],
  rosters: [
    ['scorer', 'big1', 'big2'],
    ['boards', 'guard', 'filler'],
    ['t1', 't2', 't3'],
  ],
  rosterSpots: 3,
  freeAgents: ['fa1', 'fa2'],
  rest: (id) => rest[id] ?? 0,
  catValue: (id) => values[id],
  availability: () => 1,
  gamesLeft: 60,
};

describe('rostersAfter', () => {
  it('drops the lowest-valued player from a side that receives more, and fills a side that sends more from the free agents', () => {
    const { mine, partner } = rostersAfter(state, 0, 1, ['scorer'], ['boards', 'filler']);
    expect(mine.after).toEqual(['big1', 'big2', 'boards']);
    expect(mine.dropped).toEqual(['filler']);
    expect(partner.after).toEqual(['guard', 'scorer', 'fa1']);
    expect(partner.added).toEqual(['fa1']);
  });
});

describe('tradeImpact', () => {
  const standings = leagueStandings(state, 0)!;
  it('credits a trade that gives up value for the kept categories', () => {
    // the scorer is worth twice the rebounder, but adds nothing the manager is playing for
    const impact = tradeImpact(state, standings, 0, 1, ['scorer'], ['boards']);
    expect(impact.mine.gain).toBeGreaterThan(0.05);
    expect(impact.ups).toEqual(['z_rebounds_total', 'z_blocks']);
    expect(impact.downs).toEqual([]);
    expect(impact.mine.scoreAfter).toBeGreaterThan(impact.mine.scoreBefore);
    // the partner gets the scorer's negatives in these categories: they lose ground in them
    expect(impact.partner.gain).toBeLessThan(0);
  });
  it('reads a trade the other way as a loss', () => {
    const impact = tradeImpact(state, standings, 0, 1, ['big1'], ['guard']);
    expect(impact.mine.gain).toBeLessThan(0);
    expect(impact.downs.length).toBeGreaterThan(0);
  });
  it('counts rotisserie points: one per category plus one per rival finished ahead of', () => {
    const roto = { ...state, format: 'roto' as const };
    const impact = tradeImpact(roto, leagueStandings(roto, 0)!, 0, 1, [], []);
    expect(impact.mine.scoreBefore).toBeGreaterThanOrEqual(2);
    expect(impact.mine.scoreBefore).toBeLessThanOrEqual(6);
    expect(impact.mine.gain).toBeCloseTo(0, 9);
  });
  it('weights the manager’s gain by the focus categories, and leaves the shown count plain (#680)', () => {
    const plain = tradeImpact(state, standings, 0, 1, ['scorer'], ['boards']);
    expect(plain.mine.weightedGain).toBeCloseTo(plain.mine.gain, 9);
    const focused = { ...state, focus: { z_rebounds_total: 1.5, z_blocks: 1 } };
    const f = tradeImpact(focused, standings, 0, 1, ['scorer'], ['boards']);
    expect(f.mine.gain).toBeCloseTo(plain.mine.gain, 9);
    const reb = (f.mine.after['z_rebounds_total'] ?? 0) - (f.mine.before['z_rebounds_total'] ?? 0);
    expect(f.mine.weightedGain).toBeCloseTo(plain.mine.gain + 0.5 * reb, 9);
  });
  it('is not judged without a rival roster', () => {
    expect(leagueStandings({ ...state, rosters: [['scorer'], [], []] }, 0)).toBeNull();
  });
});

describe('both sides (#682)', () => {
  const standings = leagueStandings(state, 0)!;
  it('reads each team’s needs from the standings', () => {
    const needs = teamNeeds(state, standings, 0);
    expect(needs.swing.length).toBeLessThanOrEqual(3);
    for (const c of [...needs.conceding, ...needs.locked]) expect(state.cats).toContain(c);
    expect(needs.conceding.some((c) => needs.locked.includes(c))).toBe(false);
  });
  it('lists the partner’s categories that move', () => {
    const impact = tradeImpact(state, standings, 0, 1, ['scorer'], ['boards']);
    expect(impact.partnerDowns.length).toBeGreaterThan(0);
  });
  it('judges a trade from both sides', () => {
    expect(objective(0.2, 0.1, 0.05)).toBe('win-win');
    // win-win needs both to gain: one gaining and the other even is not (#694)
    expect(objective(0.2, 0, 0.05)).toBe('you');
    expect(objective(0.02, 0.17, 0.05)).toBe('them');
    expect(objective(0.2, -0.1, 0.05)).toBe('you');
    expect(objective(-0.2, 0.1, 0.05)).toBe('them');
    expect(objective(0.01, -0.01, 0.05)).toBe('even');
    expect(objective(-0.2, -0.2, 0.05)).toBe('neither');
    expect(objective(-0.2, 0, 0.05)).toBe('neither');
  });
});
