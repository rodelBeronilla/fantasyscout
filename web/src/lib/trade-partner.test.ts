import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, normalize, owners } from './fantasy-league';
import { CATEGORIES } from './format';
import { leagueState } from './league-model';
import { bothBuilds, bothNeeds, partnerSide, worthUnder } from './trade-partner';
import { leagueStandings, tradeImpact } from './trade-impact';

// the partner's star scores (points, threes, assists); the manager's big rebounds and blocks
const player = (id: string, z: Partial<Record<string, number>>) => ({
  player_id: id,
  position: 'F',
  games_share: 1,
  ros_factor: 1,
  season_complete: false,
  games_remaining: 60,
  availability_multiplier: 1,
  ...Object.fromEntries(CATEGORIES.map((c) => [c, z[c] ?? 0])),
});
const rows = [
  player('star', { z_points: 4, z_three_pointers_made: 3, z_assists: 3, z_rebounds_total: 0.4 }),
  player('big', { z_rebounds_total: 1.5, z_blocks: 1.5 }),
  player('m2', { z_steals: 1, z_rebounds_total: 0.5 }),
  player('m3', { z_blocks: 1, z_field_goal_pct: 0.5 }),
  player('p2', { z_points: 1, z_assists: 1 }),
  player('p3', { z_three_pointers_made: 1, z_steals: 0.5 }),
  player('t1', { z_points: 1, z_rebounds_total: 1 }),
  player('t2', { z_assists: 1, z_blocks: 0.5 }),
  player('t3', { z_steals: 1, z_free_throw_pct: 0.5 }),
  ...Array.from({ length: 6 }, (_, i) => player(`fa-${i}`, { z_rebounds_total: -i / 10 })),
];
const PUNTS = ['z_points', 'z_three_pointers_made', 'z_assists'];
const setup = normalize(
  { teams: 3, rosterSpots: 3, format: 'h2h', punts: PUNTS, mine: 0, rosters: [['big', 'm2', 'm3'], ['star', 'p2', 'p3'], ['t1', 't2', 't3']] },
  DEFAULT_SETTINGS.nba,
);
const owner = owners(setup);

describe("each side of a trade under its own build (#938)", () => {
  const { worth, cats } = worthUnder(rows, setup);
  const state = leagueState(rows, { league: 'nba', format: 'h2h', points: false, cats, rosters: setup.rosters, il: [], rosterSpots: 3, owner, worth, week: false })!;
  const standings = leagueStandings(state, 0)!;
  const side = partnerSide(rows, { league: 'nba', setup, owner, partner: 1, week: false });

  it("values the partner on every category the league scores, the manager on the kept ones", () => {
    expect(cats).toEqual(CATEGORIES.filter((c) => !PUNTS.includes(c)));
    expect(side?.cats).toEqual(CATEGORIES);
    // the star's scoring counts to the partner, not to the punting manager
    expect(side?.worth.get('star')?.perGame).toBeGreaterThan(worth.get('star')?.perGame ?? 0);
  });

  it("charges the partner for the scoring they give up, which the manager's punts hid", () => {
    const own = tradeImpact(state, standings, 0, 1, ['big'], ['star']);
    const both = bothBuilds(state, standings, side, 0, 1, ['big'], ['star']);
    // under the manager's punts the partner loses nothing it counts in scoring
    expect(own.partnerDowns).not.toContain('z_points');
    expect(both.partnerDowns).toEqual(expect.arrayContaining(['z_points', 'z_assists']));
    expect(both.partner.gain).toBeLessThan(own.partner.gain);
    // the manager's side is the manager's build either way
    expect(both.mine).toEqual(own.mine);
    expect(both.ups).toEqual(own.ups);
    expect(both.sides.mine).toEqual(own.sides.mine);
  });

  it("reads each team's needs under its own build", () => {
    const needs = bothNeeds(state, standings, side, 0, 1);
    expect([...needs.mine.swing, ...needs.mine.conceding, ...needs.mine.locked].some((c) => PUNTS.includes(c))).toBe(false);
    expect([...needs.partner.swing, ...needs.partner.conceding, ...needs.partner.locked].some((c) => PUNTS.includes(c))).toBe(true);
  });

  it('falls back to the one build without a partner', () => {
    expect(partnerSide(rows, { league: 'nba', setup, owner, partner: -1, week: false })).toBeNull();
    expect(bothBuilds(state, standings, null, 0, 1, ['big'], ['star'])).toEqual(tradeImpact(state, standings, 0, 1, ['big'], ['star']));
  });
});
