import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, migrate, SETUP_VERSION } from './fantasy-league';

const nba = DEFAULT_SETTINGS.nba;

describe('the stored league setup migrates by version', () => {
  it.each([
    ['nothing stored', undefined, {}, { teams: 12, il: [], mine: 0, rosters: Array.from({ length: 12 }, () => []) }],
    [
      'the first League page (no version): the Mine marks join the manager\'s team',
      { teams: 4, names: ['Me', 'B', 'C', 'D'], rosters: [['p1'], ['p2'], [], []], mine: 0, picks: [] },
      { marks: ['p9', 'p1'] },
      { teams: 4, il: [], mine: 0, rosters: [['p1', 'p9'], ['p2'], [], []] },
    ],
    [
      'version 1 (no injured list, no weights): the list arrives empty and the weights take the preset',
      { version: 1, teams: 4, rosters: [['p1'], [], [], []], mine: 1 },
      {},
      { teams: 4, il: [], mine: 1, rosters: [['p1'], [], [], []] },
    ],
    [
      'version 2 (no format, no opponent): rotisserie, nobody to face',
      { version: 2, teams: 4, rosters: [['p1', 'p2'], [], [], []], il: ['p2'], mine: 0, scoring: 'points' },
      {},
      { teams: 4, il: ['p2'], mine: 0, rosters: [['p1', 'p2'], [], [], []], format: 'roto', opponent: null },
    ],
    [
      'version 3 (no punts): none',
      { version: 3, teams: 4, rosters: [['p1'], ['p2'], [], []], il: [], mine: 0, format: 'h2h', opponent: 1 },
      {},
      { teams: 4, il: [], mine: 0, rosters: [['p1'], ['p2'], [], []], format: 'h2h', opponent: 1, punts: [] },
    ],
    [
      'version 4: unknown punts dropped',
      { version: 4, teams: 4, rosters: [['p1'], [], [], []], il: [], mine: 0, punts: ['z_assists', 'z_points', 'nonsense'] },
      {},
      { teams: 4, rosters: [['p1'], [], [], []], punts: ['z_points', 'z_assists'] },
    ],
    [
      'version 5 (focus categories, withdrawn in 6): the punts stay, the focus goes',
      { version: 5, teams: 4, rosters: [['p1'], [], [], []], il: [], mine: 0, punts: ['z_points'], focus: ['z_blocks', 'z_points', 'z_steals'] },
      {},
      { teams: 4, punts: ['z_points'] },
    ],
    [
      'version 6 (no source, #815): entered by hand',
      { version: 6, teams: 4, rosters: [['p1'], [], [], []], il: [], mine: 0 },
      {},
      { teams: 4, rosters: [['p1'], [], [], []] },
    ],
    [
      'version 7 keeps where the league came from',
      {
        version: 7,
        teams: 4,
        rosters: [['p1'], [], [], []],
        il: [],
        mine: 0,
        source: { host: 'espn', leagueId: '42', season: '2026-27', syncedAt: 5, rosters: [['p1'], [], [], []], teamIds: [1, 2, 3, 4], changes: 2 },
      },
      {},
      { teams: 4, source: { host: 'espn', leagueId: '42', season: '2026-27', syncedAt: 5, rosters: [['p1'], [], [], []], teamIds: [1, 2, 3, 4], changes: 2 } },
    ],
    [
      'a newer build\'s object keeps what this build understands',
      { version: 99, teams: 4, rosters: [['p1'], [], [], []], il: [], mine: 0, future: true },
      {},
      { teams: 4, il: [], mine: 0, rosters: [['p1'], [], [], []] },
    ],
    ['junk', 'not an object', {}, { teams: 12, il: [], mine: 0, rosters: Array.from({ length: 12 }, () => []) }],
  ])('%s', (_name, raw, legacy, expected) => {
    const setup = migrate(raw, nba, legacy);
    expect(setup).toMatchObject(expected);
    expect(setup.weights).toEqual(expect.objectContaining(nba.weights));
    expect('version' in setup).toBe(false);
    expect('focus' in setup).toBe(false);
  });

  it("keeps a source's well-formed scores so far and blanks a malformed one (#817)", () => {
    const good = { totals: { z_points: 120 }, shots: { z_field_goal_pct: [40, 90] } };
    const scores = [good, { totals: { z_points: 'lots' }, shots: {} }, { totals: {}, shots: { z_free_throw_pct: [1] } }, null];
    const setup = migrate({ version: 7, teams: 4, source: { host: 'espn', leagueId: '1', syncedAt: 1, rosters: [], scores } }, nba);
    expect(setup.source?.scores).toEqual([good, null, null, null]);
  });

  it('drops a source a version 6 copy could not have written (#815)', () => {
    const setup = migrate({ version: 6, teams: 4, source: { host: 'espn', leagueId: '1', syncedAt: 1, rosters: [] } }, nba);
    expect('source' in setup).toBe(false);
  });

  it('gives a version 7 copy the default playoffs, no more teams than the league holds (#821)', () => {
    expect(migrate({ version: 7, teams: 12 }, nba).playoffs).toEqual({ teams: 6, weeks: 3, start: null });
    expect(migrate({ version: 7, teams: 4 }, nba).playoffs).toEqual({ teams: 4, weeks: 3, start: null });
    expect(migrate({ version: 7, teams: 10 }, DEFAULT_SETTINGS.wnba).playoffs).toEqual({ teams: 4, weeks: 2, start: null });
  });

  it('keeps a version 8 copy\'s playoffs, bounded to the league and the weeks planned', () => {
    expect(migrate({ version: 8, teams: 8, playoffs: { teams: 4, weeks: 2 } }, nba).playoffs).toEqual({ teams: 4, weeks: 2, start: null });
    expect(migrate({ version: 8, teams: 8, playoffs: { teams: 12, weeks: 0 } }, nba).playoffs).toEqual({ teams: 8, weeks: 1, start: null });
    expect(migrate({ version: 8, teams: 8, playoffs: { teams: 'x' } }, nba).playoffs).toEqual({ teams: 6, weeks: 3, start: null });
  });

  it("keeps a source's well-formed playoff weeks, fixtures and tally and drops malformed ones (#821)", () => {
    const source = { host: 'espn', leagueId: '1', syncedAt: 1, rosters: [] };
    const good = migrate(
      { version: 8, teams: 4, source: { ...source, playoffWeeks: { periods: [4, 4], from: '2026-11-15', to: '2026-11-21' }, fixtures: [[[0, 1], [2, 3]]], tally: 'matchups' } },
      nba,
    ).source;
    expect(good).toMatchObject({ playoffWeeks: { periods: [4, 4], from: '2026-11-15', to: '2026-11-21' }, fixtures: [[[0, 1], [2, 3]]], tally: 'matchups' });
    const bad = migrate({ version: 8, teams: 4, source: { ...source, playoffWeeks: { periods: [4], from: 'soon' }, fixtures: [[[0, 'x']]], tally: 'most' } }, nba).source;
    expect(bad && ('playoffWeeks' in bad || 'fixtures' in bad || 'tally' in bad)).toBe(false);
  });

  it('gives a version 8 copy no first playoff week and no records entered, keeping its teams and weeks (#874)', () => {
    const setup = migrate({ version: 8, teams: 8, playoffs: { teams: 4, weeks: 2 } }, nba);
    expect(setup.playoffs).toEqual({ teams: 4, weeks: 2, start: null });
    expect(setup.standings).toEqual({ records: Array(8).fill(null), tally: 'categories' });
  });

  it('keeps a version 9 copy\'s first playoff week as its Monday, and its well-formed records', () => {
    const record = { wins: 5, losses: 3, ties: 1, seed: null };
    const setup = migrate(
      { version: 9, teams: 4, playoffs: { teams: 4, weeks: 3, start: '2027-03-18' }, standings: { records: [record, { wins: -1 }, null], tally: 'matchups' } },
      nba,
    );
    // a Thursday stands for its week: the Monday before
    expect(setup.playoffs.start).toBe('2027-03-15');
    expect(setup.standings).toEqual({ records: [record, null, null, null], tally: 'matchups' });
    expect(migrate({ version: 9, teams: 4, playoffs: { teams: 4, weeks: 3, start: 'soon' } }, nba).playoffs.start).toBeNull();
  });

  it('is at version 9', () => {
    expect(SETUP_VERSION).toBe(9);
  });
});
