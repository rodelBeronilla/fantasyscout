import { describe, expect, it } from 'vitest';

import { gainerDetail, gainerNote, minutesByPlayer, minutesGoTo, type MinutesRow } from './minutes-go-to';

const row = (teammate: string, gained: number, rank: number, extra: Partial<MinutesRow> = {}): MinutesRow => ({
  team_id: 'T',
  player_id: 'star',
  games_missed: 6,
  teammate_id: teammate,
  teammate_name: teammate.toUpperCase(),
  teammate_games_without: 6,
  minutes_with: 20,
  minutes_without: 20 + gained,
  minutes_gained: gained,
  gain_rank: rank,
  teammate_percent_owned: null,
  ...extra,
});

const rows = [row('cole', 2, 3), row('brown', 8.4, 1, { teammate_percent_owned: 41.2 }), row('dunn', 5, 2, { teammate_percent_owned: 12 })];
const name = (t: number) => `Team ${t + 1}`;

describe('who takes an out player’s minutes', () => {
  it('orders each player’s gainers by rank', () => {
    const by = minutesByPlayer([...rows, { ...row('x', 3, 1), player_id: 'other' }]);
    expect(by.get('star')?.map((r) => r.teammate_id)).toEqual(['brown', 'dunn', 'cole']);
    expect(by.get('other')).toHaveLength(1);
  });

  it('names the top gainer, and he is the pickup when he is free', () => {
    const call = minutesGoTo(minutesByPlayer(rows).get('star'), 'T', new Map())!;
    expect(call.top.id).toBe('brown');
    expect(call.pickup?.id).toBe('brown');
    expect(gainerNote(call.top, name, 0)).toBe('+8, 41% rostered');
  });

  it('says who has the top gainer, and picks the best gainer still free', () => {
    const call = minutesGoTo(minutesByPlayer(rows).get('star'), 'T', new Map([['brown', 3]]))!;
    expect(gainerNote(call.top, name, 0)).toBe('+8, on Team 4');
    expect(call.pickup?.id).toBe('dunn');
    expect(gainerNote(call.pickup!, name, 0)).toBe('+5, 12% rostered');
    // on the manager's own team
    expect(gainerNote(minutesGoTo(rows, 'T', new Map([['brown', 0]]))!.top, name, 0)).toBe('+8, on your team');
  });

  it('has no pickup when every gainer is taken, and leaves out the share ESPN does not give', () => {
    const owned = new Map([['brown', 1], ['dunn', 2], ['cole', 3]]);
    expect(minutesGoTo(minutesByPlayer(rows).get('star'), 'T', owned)?.pickup).toBeNull();
    expect(gainerNote(minutesGoTo([row('cole', 2.6, 1)], 'T', new Map())!.top, name, 0)).toBe('+3');
  });

  it('says nothing without a gain, or for a player whose rows are for a team he has left', () => {
    expect(minutesGoTo(undefined, 'T', new Map())).toBeNull();
    expect(minutesGoTo([row('cole', 0, 1)], 'T', new Map())).toBeNull();
    expect(minutesGoTo(rows, 'U', new Map())).toBeNull();
    // the board without a team for him: the rows stand
    expect(minutesGoTo(rows, null, new Map())?.top.id).toBe('brown');
  });

  it('explains the number on hover', () => {
    const call = minutesGoTo(minutesByPlayer(rows).get('star'), 'T', new Map())!;
    expect(gainerDetail(call.top, 'Star')).toBe('BROWN averaged 28 minutes in the 6 games Star missed and 20 in the games Star played, this season and last.');
  });
});
