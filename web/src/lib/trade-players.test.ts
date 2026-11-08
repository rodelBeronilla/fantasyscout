import { describe, expect, it } from 'vitest';
import type { Worth } from './league-model';
import { formOf, HOT, profileOf, teamChange, timingNotes, type TradePlayer, tradeSide } from './trade-players';

const player = (id: string, fields: Record<string, unknown> = {}): TradePlayer =>
  ({ player_id: id, full_name: `Player ${id}`, injury_group: null, injury_status: null, games_this_week: 0, ...fields }) as unknown as TradePlayer;

const worthOf = (rest: number, cats: Record<string, number> = {}, week = rest): Worth => ({ perGame: rest / 10, season: rest * 2, rest, week, cats, fpts: null });

describe('a side of a trade', () => {
  const byId = new Map([player('a', { games_this_week: 3 }), player('b', { games_this_week: 2 }), player('c')].map((p) => [p.player_id, p]));
  const worth = new Map([
    ['a', worthOf(10, { pts: 1.5, ast: -0.5 }, 4)],
    ['b', worthOf(-2, { pts: -1, ast: 0.25 }, -1)],
  ]);

  it('counts a player below replacement as zero in value, but keeps his categories', () => {
    const side = tradeSide(['a', 'b'], byId, worth, ['pts', 'ast'], false);
    expect(side.players.map((p) => p.player_id)).toEqual(['a', 'b']);
    expect(side.rest).toBe(10);
    expect(side.value).toBe(10);
    expect(side.perGame).toBe(1);
    expect(side.cats).toEqual({ pts: 0.5, ast: -0.25 });
    expect(side.belowReplacement.map((p) => p.player_id)).toEqual(['b']);
    expect(side.games).toBe(5);
  });

  it('judges this week on the week figure', () => {
    const side = tradeSide(['a', 'b'], byId, worth, ['pts'], true);
    expect(side.value).toBe(4);
    expect(side.week).toBe(4);
    expect(side.rest).toBe(10);
  });

  it('leaves out an id the board does not have, and values a player it does not price at nothing', () => {
    const side = tradeSide(['a', 'zz', 'c'], byId, worth, ['pts'], false);
    expect(side.players.map((p) => p.player_id)).toEqual(['a', 'c']);
    expect(side.value).toBe(10);
    expect(side.belowReplacement).toEqual([]);
  });
});

describe("the manager's team before and after", () => {
  const worth = new Map([
    ['m1', worthOf(1, { pts: 3 })],
    ['m2', worthOf(1, { pts: 1 })],
    ['p1', worthOf(1, { pts: 5 })],
    ['o1', worthOf(1, { pts: 4 })],
    ['hurt', worthOf(1, { pts: 9 })],
  ]);
  const rosters = [['m1', 'm2', 'hurt'], ['p1'], ['o1'], []];

  it('swaps the players, leaves the injured list out of the totals and ranks the teams with a roster', () => {
    const change = teamChange({ rosters, mine: 0, partner: 1, il: ['hurt'], give: ['m2'], get: ['p1'], cats: ['pts'], worth });
    expect(change.ranked).toBe(3);
    expect(change.rows).toEqual([{ c: 'pts', before: 4, after: 8, rankBefore: 2, rankAfter: 1 }]);
  });

  it('changes nothing for a trade with no players', () => {
    const change = teamChange({ rosters, mine: 0, partner: 1, il: [], give: [], get: [], cats: ['pts'], worth });
    expect(change.rows[0]?.before).toBe(13);
    expect(change.rows[0]?.after).toBe(13);
    expect(change.rows[0]?.rankBefore).toBe(change.rows[0]?.rankAfter);
  });
});

describe("a player's form and profile", () => {
  it('sums the last ten games against the projection over the kept categories it can read', () => {
    const p = player('a', { pts: 1, recent_pts: 2.5, ast: 0.5, recent_ast: 0, reb: 1 });
    expect(formOf(p, ['pts', 'ast', 'reb'])).toBe(1);
    expect(formOf(p, ['reb'])).toBeNull();
    expect(formOf(player('b', { pts: Number.NaN, recent_pts: 1 }), ['pts'])).toBeNull();
  });

  it('names the two best categories past half a point, and the worst', () => {
    expect(profileOf({ pts: 2, ast: 0.6, reb: 1, stl: -0.7, blk: -1.2 }, ['pts', 'ast', 'reb', 'stl', 'blk'])).toEqual({ best: ['pts', 'reb'], worst: ['blk'] });
    expect(profileOf({ pts: 0.4, ast: -0.4 }, ['pts', 'ast'])).toEqual({ best: [], worst: [] });
    expect(profileOf({ pts: 2 }, ['ast'])).toEqual({ best: [], worst: [] });
  });
});

describe('the timing notes', () => {
  const hot = player('hot', { full_name: 'Hot', pts: 0, recent_pts: HOT });
  const cold = player('cold', { full_name: 'Cold', pts: 0, recent_pts: -HOT });
  const hurt = player('hurt', { full_name: 'Hurt', injury_group: 'out', injury_status: 'Out', expected_return: '2026-12-01' });

  it('says when the manager sells high or buys low, and when an injury cuts the value', () => {
    const notes = timingNotes([hot], [cold, hurt], ['pts'], false);
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatch(/^Hot has run 1\.5 above .*you sell high\.$/);
    expect(notes[1]).toMatch(/^Cold has run 1\.5 below .*you buy low\.$/);
    expect(notes[2]).toBe('Hurt is out (expected back 2026-12-01): the value counts only the games they are expected to play.');
  });

  it('warns of buying at the top and selling low the other way round', () => {
    const notes = timingNotes([cold], [hot], ['pts'], false);
    expect(notes[0]).toMatch(/you sell low, and the projection expects them to recover\.$/);
    expect(notes[1]).toMatch(/you buy at the top, and the projection expects them to cool off\.$/);
  });

  it('reads no form in a points league', () => {
    expect(timingNotes([hot], [cold], ['pts'], true)).toEqual([]);
  });
});
