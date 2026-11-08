import { describe, expect, it, vi } from 'vitest';

import fixture from '../../tests/fixtures/espn/league.json';
import { fromEspnLeague } from './espn-league';
import { DEFAULT_SETTINGS, type LeagueSetup, normalize } from './fantasy-league';
import {
  ago,
  chooseMine,
  espnSetup,
  espnSyncLine,
  fetchEspnLeague,
  hasManualEdits,
  rosterChanges,
  SYNC_EVERY_MS,
  syncDue,
  YAHOO_STALE_MS,
  yahooSource,
  yahooStale,
} from './league-sync';

const players = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((n, i) => ({ player_id: `p${i}`, full_name: `Player ${n}` }));
const at = { leagueId: '123456', season: '2026-27', now: 1_000_000_000_000 };
const MIN = 60_000;

/** The fixture league as a first import, the manager's team picked as `mine`. */
function imported(mine = 0): LeagueSetup {
  return chooseMine(espnSetup(fromEspnLeague(fixture), players, at, null).setup, mine);
}

describe("this week's opponent from ESPN's schedule (#815)", () => {
  it('pairs each team with the one it faces in the current matchup period, both ways', () => {
    const l = fromEspnLeague(fixture);
    // period 2: team 3 hosts team 1, team 2 hosts team 4
    expect([...l.opponents.entries()].sort()).toEqual([
      [1, 3],
      [2, 4],
      [3, 1],
      [4, 2],
    ]);
  });

  it("finds the period from today's scoring period when ESPN names no current one", () => {
    const l = fromEspnLeague({ ...fixture, status: {}, scoringPeriodId: 16 });
    expect(l.opponents.get(1)).toBe(4);
  });

  it('has no opponent on a bye or without a schedule', () => {
    const bye = { ...fixture, schedule: fixture.schedule.map((m) => (m.matchupPeriodId === 2 && m.home.teamId === 3 ? { ...m, away: undefined } : m)) };
    expect(fromEspnLeague(bye).opponents.has(1)).toBe(false);
    expect(fromEspnLeague({ ...fixture, schedule: undefined }).opponents.size).toBe(0);
  });

  it("sets the manager's opponent on import, and again when they pick their team", () => {
    const first = espnSetup(fromEspnLeague(fixture), players, at, null).setup;
    expect(first.mine).toBe(0);
    expect(first.opponent).toBe(2);
    expect(first.source?.opponents).toEqual([2, 3, 0, 1]);
    expect(chooseMine(first, 1).opponent).toBe(3);
  });
});

describe('a re-import (#815)', () => {
  it('counts the roster adds and drops against the stored copy and keeps the manager’s own choices', () => {
    const stored = imported(1);
    // since then: team 1 dropped Player Six for Player Five; the manager punts points and moved the opponent
    const changed = { ...fixture, teams: fixture.teams.map((t) => (t.id === 1 ? { ...t, roster: { entries: [...t.roster.entries.slice(0, 2), { lineupSlotId: 12, playerPoolEntry: { player: { fullName: 'Player Five' } } }] } } : t)) };
    const result = espnSetup(fromEspnLeague(changed), players, { ...at, now: at.now + 20 * MIN }, { ...stored, punts: ['z_points'] });
    expect(result.changes).toBe(2);
    expect(result.setup.source?.changes).toBe(2);
    expect(result.setup.source?.syncedAt).toBe(at.now + 20 * MIN);
    expect(result.setup.rosters[0]).toEqual(['p0', 'p1', 'p5']);
    expect(result.setup.mine).toBe(1);
    expect(result.setup.opponent).toBe(3);
    expect(result.setup.punts).toEqual(['z_points']);
    expect(hasManualEdits(result.setup)).toBe(false);
  });

  it('follows the manager’s team by its ESPN id when ESPN lists the teams in another order', () => {
    const stored = imported(1);
    const result = espnSetup(fromEspnLeague({ ...fixture, teams: [...fixture.teams].reverse() }), players, at, stored);
    expect(result.setup.names[result.setup.mine]).toBe('Glass Cleaners');
    expect(result.setup.names[result.setup.opponent!]).toBe('Fourth');
    // the same rosters under other places: nothing changed
    expect(result.changes).toBe(0);
  });

  it('counts a trade on both sides, and a first import as no count', () => {
    expect(rosterChanges([['a', 'b'], ['c']], [['a', 'c'], ['b']])).toBe(4);
    expect(rosterChanges([['a']], [['a']])).toBe(0);
    expect(espnSetup(fromEspnLeague(fixture), players, at, null).changes).toBeNull();
  });
});

describe('when a visit re-imports (#815)', () => {
  it('waits a quarter hour after the last sync', () => {
    const s = imported();
    expect(syncDue(s, at.now)).toBe('fresh');
    expect(syncDue(s, at.now + 14 * MIN)).toBe('fresh');
    expect(syncDue(s, at.now + SYNC_EVERY_MS)).toBe('due');
    expect(SYNC_EVERY_MS).toBe(15 * MIN);
  });

  it('never replaces rosters edited by hand since the import', () => {
    const s = imported();
    const edited = { ...s, rosters: s.rosters.map((r, i) => (i === 0 ? [...r, 'p5'] : r)) };
    expect(hasManualEdits(edited)).toBe(true);
    expect(syncDue(edited, at.now + 60 * MIN)).toBe('edited');
    // the same players in another order are not an edit; picking a team or an opponent is not either
    expect(hasManualEdits({ ...s, rosters: s.rosters.map((r) => [...r].reverse()), mine: 2, opponent: 1 })).toBe(false);
  });

  it('leaves a league entered by hand, or from Yahoo, alone', () => {
    const plain = normalize({ teams: 4 }, DEFAULT_SETTINGS.nba);
    expect(syncDue(plain, at.now)).toBe('none');
    expect(syncDue({ ...plain, source: yahooSource('99', plain.rosters, 0) }, at.now)).toBe('none');
  });

  it('keeps the source through the stored shape', () => {
    const s = imported();
    const again = normalize(JSON.parse(JSON.stringify(s)) as LeagueSetup, DEFAULT_SETTINGS.nba);
    expect(again.source).toEqual(s.source);
  });
});

describe('fetchEspnLeague (#815)', () => {
  it('reads the league, schedule included, and says what to do about a private one', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const l = await fetchEspnLeague('123456', '2026-27', ok as unknown as typeof fetch);
    expect(String((ok.mock.calls[0] as unknown[])[0])).toContain('view=mMatchupScore');
    expect(l.opponents.get(1)).toBe(3);
    const denied = vi.fn(async () => new Response('{}', { status: 401 }));
    await expect(fetchEspnLeague('1', '2026-27', denied as unknown as typeof fetch)).rejects.toThrow(/Make League Viewable to Public/);
  });
});

describe('the synced line (#815)', () => {
  it('says how long ago and how many roster changes', () => {
    const s = imported().source!;
    expect(espnSyncLine(s, at.now + 4 * MIN)).toBe('Synced 4 min ago');
    expect(espnSyncLine({ ...s, changes: 2 }, at.now + 4 * MIN)).toBe('Synced 4 min ago · 2 roster changes since your last visit');
    expect(espnSyncLine({ ...s, changes: 1 }, at.now)).toBe('Synced just now · 1 roster change since your last visit');
    expect(espnSyncLine({ ...s, changes: 0 }, at.now)).toBe('Synced just now · no roster changes since your last visit');
  });

  it('words an age in minutes, hours or days', () => {
    expect(ago(0, 30_000)).toBe('just now');
    expect(ago(0, 59 * MIN)).toBe('59 min ago');
    expect(ago(0, 60 * MIN)).toBe('1 hour ago');
    expect(ago(0, 5 * 60 * MIN)).toBe('5 hours ago');
    expect(ago(0, 3 * 24 * 60 * MIN)).toBe('3 days ago');
  });

  it('offers a Yahoo re-sync once the copy is a day old', () => {
    const y = yahooSource('99', [], at.now);
    expect(yahooStale(y, at.now + YAHOO_STALE_MS - 1)).toBe(false);
    expect(yahooStale(y, at.now + YAHOO_STALE_MS)).toBe(true);
  });
});
