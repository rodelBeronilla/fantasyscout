import { describe, expect, it } from 'vitest';

import { buildPlan, type PlanInput, type PlanModel } from './build-plan';
import { type LeagueState, leagueStandings, meaningful } from './trade-impact';

// A manager punting points: rebounds and assists are strengths, blocks the need. The scorer's
// value is all in points, so he does nothing for this build.
const values: Record<string, Record<string, number>> = {
  star: { z_rebounds_total: 3, z_blocks: 0, z_assists: 3 },
  mid: { z_rebounds_total: 1, z_blocks: 0, z_assists: 1 },
  scorer: { z_points: 3, z_rebounds_total: -0.2, z_blocks: -0.2, z_assists: -0.2 },
  a1: { z_rebounds_total: 1, z_blocks: 2, z_assists: -1 },
  a2: { z_rebounds_total: 0, z_blocks: 1.2, z_assists: -0.5 },
  a3: { z_rebounds_total: 1, z_blocks: 2, z_assists: -1 },
  b1: { z_rebounds_total: 1.5, z_blocks: 1, z_assists: 1 },
  b2: { z_rebounds_total: 0.5, z_blocks: 0.5, z_assists: 0.5 },
  b3: { z_rebounds_total: 0.5, z_blocks: 0.5, z_assists: 0.5 },
  // free agents: a shot blocker, and one whose value is all in the punted category
  faBlk: { z_rebounds_total: 0, z_blocks: 1, z_assists: 0 },
  faPts: { z_points: 5, z_rebounds_total: 0, z_blocks: 0, z_assists: 0 },
};
const rest: Record<string, number> = { star: 30, mid: 10, scorer: 1, a1: 10, a2: 3.5, a3: 10, b1: 17.5, b2: 7.5, b3: 7.5, faBlk: 5, faPts: 9 };
const positions: Record<string, string> = { star: 'C', mid: 'G', scorer: 'F', a1: 'G-F', a2: 'F', a3: 'G', b1: 'C', b2: 'G', b3: 'F', faBlk: 'F', faPts: 'F' };
const cats = ['z_rebounds_total', 'z_blocks', 'z_assists'];
const rosters = [
  ['star', 'mid', 'scorer'],
  ['a1', 'a2', 'a3'],
  ['b1', 'b2', 'b3'],
];
const owner = new Map(rosters.flatMap((r, t) => r.map((id) => [id, t] as const)));

const state: LeagueState = {
  league: 'nba',
  format: 'h2h',
  cats,
  rosters,
  rosterSpots: 3,
  freeAgents: ['faPts', 'faBlk'],
  rest: (id) => rest[id] ?? 0,
  catValue: (id) => values[id],
  availability: () => 1,
  gamesLeft: 60,
};
const standings = leagueStandings(state, 0)!;
const model: PlanModel = { state, standings, acceptable: () => true };

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  cats,
  punted: ['z_points'],
  mine: 0,
  roster: rosters[0]!,
  others: Object.keys(values).filter((id) => owner.get(id) !== 0),
  owner: (id) => owner.get(id),
  rest: (id) => rest[id] ?? 0,
  catValue: (id) => values[id],
  scale: (_id, perGame) => perGame * 10,
  position: (id) => positions[id],
  model,
  ...over,
});

describe('buildPlan with rival rosters', () => {
  const plan = buildPlan(input());

  it('reads the category picture from the standings: rank, chance and the swing, locked and conceding labels', () => {
    expect(plan.standings).toBe(true);
    expect(plan.picture.map((p) => p.cat)).toEqual(cats);
    expect(plan.punted).toEqual(['z_points']);
    const blocks = plan.picture.find((p) => p.cat === 'z_blocks')!;
    const assists = plan.picture.find((p) => p.cat === 'z_assists')!;
    expect(blocks.rank).toBe(3);
    expect(assists.rank).toBe(1);
    expect(blocks.teams).toBe(3);
    expect(blocks.chance!).toBeLessThan(assists.chance!);
    expect(plan.picture.every((p) => p.labels.every((l) => ['swing', 'locked', 'conceding'].includes(l)))).toBe(true);
  });

  it('ranks targets by the expected categories they add in place of the least useful player', () => {
    expect(plan.targets.length).toBeGreaterThan(0);
    const scores = plan.targets.map((t) => t.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(scores.every((s) => s >= meaningful(state, 0))).toBe(true);
    // the shot blocker is the free agent the build wants, swapped for the scorer
    const blk = plan.targets.find((t) => t.id === 'faBlk')!;
    expect(blk.team).toBeNull();
    expect(blk.move).toEqual({ kind: 'pickup', add: 'faBlk', drop: 'scorer', gain: blk.score });
    expect(blk.reasons[0]?.cat).toBe('z_blocks');
  });

  it('counts a punted category for nothing', () => {
    // the points specialist is worth more by rest of season than the shot blocker, but only in
    // points: he gains only what any replacement for the scorer would
    const pts = plan.targets.find((t) => t.id === 'faPts')!;
    const blk = plan.targets.find((t) => t.id === 'faBlk')!;
    expect(pts.score).toBeLessThan(blk.score);
    expect(plan.targets.flatMap((t) => t.reasons).some((r) => r.cat === 'z_points')).toBe(false);
    expect(plan.picture.some((p) => p.cat === 'z_points')).toBe(false);
  });

  it('offers a rostered target only with a fair package from the players let go', () => {
    // the rival big is a two-for-one: the scorer and the guard, worth a little more than him, for him
    const big = plan.targets.find((t) => t.id === 'a1')!;
    expect(big.team).toBe(1);
    expect(big.move).toMatchObject({ kind: 'trade', partner: 1, give: ['scorer', 'mid'], get: ['a1'] });
    expect(big.move!.gain).toBeGreaterThanOrEqual(meaningful(state, 0));
    // the better big costs more than the players let go are worth, and his team gains nothing: no deal
    expect(plan.targets.some((t) => t.id === 'b1')).toBe(false);
    // and none passes a fairness check that turns everything down
    const none = buildPlan(input({ model: { ...model, acceptable: () => false } }));
    expect(none.targets.map((t) => t.id)).toEqual(['faBlk', 'faPts']);
  });

  it('lists the players let go two ways: the cheapest to lose, and the lowest value', () => {
    expect(plan.surplus[0]?.id).toBe('scorer');
    expect(plan.surplus.map((p) => p.id)).not.toContain(undefined);
    expect(plan.lowest.map((p) => p.id)).toEqual(['scorer', 'mid', 'star']);
    const costs = plan.surplus.map((p) => p.score);
    expect([...costs].sort((a, b) => a - b)).toEqual(costs);
  });

  it('gives a player let go his best free-agent replacement when it gains, else a trade, else nothing', () => {
    const scorer = plan.surplus.find((p) => p.id === 'scorer')!;
    expect(scorer.move).toMatchObject({ kind: 'pickup', add: 'faBlk', drop: 'scorer' });
    // losing him costs nothing the build plays for
    expect(scorer.reasons).toEqual([]);
    // the star costs too much to lose for any free agent or any trade the league offers
    const star = plan.lowest.find((p) => p.id === 'star')!;
    expect(star.move).toBeNull();
    expect(star.reasons.map((r) => r.cat).sort()).toEqual(['z_assists', 'z_rebounds_total']);
    expect(star.reasons.every((r) => r.delta < 0)).toBe(true);
  });

  it('keeps the positions the roster covers', () => {
    // the scorer is now the lone center: no forward takes his spot, and the rival big (a guard or
    // forward) cannot come in for him either
    const pos: Record<string, string> = { ...positions, scorer: 'C', star: 'G' };
    const kept = buildPlan(input({ position: (id) => pos[id] }));
    for (const p of [...kept.targets, ...kept.surplus, ...kept.lowest]) {
      if (p.move?.kind === 'pickup') expect(p.move.drop).not.toBe('scorer');
      if (p.move?.kind === 'trade') expect(p.move.give).not.toContain('scorer');
    }
    expect(kept.surplus.find((p) => p.id === 'scorer')?.move).toBeNull();
  });

  it('drops only a player the drop rule lets go for a free agent', () => {
    const plan2 = buildPlan(input({ droppable: (id) => id !== 'scorer' }));
    for (const p of [...plan2.targets, ...plan2.surplus, ...plan2.lowest]) {
      if (p.move?.kind === 'pickup') expect(p.move.drop).not.toBe('scorer');
    }
    // he can still be traded
    expect(plan2.targets.find((t) => t.id === 'a1')?.move).toMatchObject({ kind: 'trade', give: ['scorer', 'mid'] });
  });

  it('lists five names at most', () => {
    const small = buildPlan(input({ limit: 1 }));
    expect(small.targets.length).toBeLessThanOrEqual(1);
    expect(small.surplus).toHaveLength(1);
    expect(small.lowest).toHaveLength(1);
  });
});

describe('buildPlan without rival rosters', () => {
  const plan = buildPlan(input({ model: null }));

  it("scores targets by Fit's need-weighted value across the whole board and leaves the deals out", () => {
    expect(plan.standings).toBe(false);
    expect(plan.targets.every((t) => t.move === null)).toBe(true);
    expect(plan.surplus.every((t) => t.move === null)).toBe(true);
    const scores = plan.targets.map((t) => t.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    // the board's rostered players are candidates too, with their team
    expect(plan.targets[0]?.team).not.toBeNull();
    // blocks are the need: the shot blocker outranks the points specialist, who adds nothing kept
    const rank = (id: string) => buildPlan(input({ model: null, limit: 20 })).targets.findIndex((t) => t.id === id);
    expect(rank('faBlk')).toBeLessThan(rank('faPts'));
  });

  it('labels the weakest and strongest thirds of the categories, no ranks', () => {
    const blocks = plan.picture.find((p) => p.cat === 'z_blocks')!;
    expect(blocks.labels).toEqual(['weak']);
    expect(blocks.rank).toBeNull();
    expect(plan.picture.some((p) => p.labels.includes('strong'))).toBe(true);
  });

  it('lets go the lowest need-weighted value and the lowest rest-of-season value', () => {
    expect(plan.surplus[0]?.id).toBe('scorer');
    expect(plan.lowest.map((p) => p.id)).toEqual(['scorer', 'mid', 'star']);
    expect(plan.surplus[0]?.reasons.some((r) => r.cat === 'z_points')).toBe(false);
  });
});
