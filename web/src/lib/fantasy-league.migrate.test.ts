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
      'version 4 (no focus): unknown punts dropped, no focus',
      { version: 4, teams: 4, rosters: [['p1'], [], [], []], il: [], mine: 0, punts: ['z_assists', 'z_points', 'nonsense'] },
      {},
      { teams: 4, rosters: [['p1'], [], [], []], punts: ['z_points', 'z_assists'], focus: [] },
    ],
    [
      'version 5: as stored; a category both punted and focused stays punted',
      { version: 5, teams: 4, rosters: [['p1'], [], [], []], il: [], mine: 0, punts: ['z_points'], focus: ['z_blocks', 'z_points', 'z_steals'] },
      {},
      { teams: 4, punts: ['z_points'], focus: ['z_steals', 'z_blocks'] },
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
  });

  it('is at version 5', () => {
    expect(SETUP_VERSION).toBe(5);
  });
});
