import { describe, expect, it } from 'vitest';

import { daysFromParam, needsFromParam, pickupsPath, withNeeds } from './pickups-url';

describe('the Pickups address (#818)', () => {
  it('reads the need categories: known ones only, each once, in order', () => {
    expect(needsFromParam('z_steals,z_blocks')).toEqual(['z_steals', 'z_blocks']);
    expect(needsFromParam('z_blocks, z_steals,z_blocks')).toEqual(['z_blocks', 'z_steals']);
    expect(needsFromParam('steals,z_nonsense,,z_turnovers')).toEqual(['z_turnovers']);
    expect(needsFromParam(null)).toEqual([]);
    expect(needsFromParam('')).toEqual([]);
  });

  it('reads the open days: ISO days only', () => {
    expect(daysFromParam('2026-11-12,2026-11-13')).toEqual(['2026-11-12', '2026-11-13']);
    expect(daysFromParam('Thu,2026-11-13,2026-1-1')).toEqual(['2026-11-13']);
    expect(daysFromParam(undefined)).toEqual([]);
  });

  it('writes the window, open days and needs into a link, with plain commas', () => {
    expect(pickupsPath('nba')).toBe('/streamers/?league=nba');
    expect(pickupsPath('nba', { week: true, open: ['2026-11-12', '2026-11-13'], need: ['z_steals', 'z_blocks'] })).toBe(
      '/streamers/?league=nba&window=week&open=2026-11-12,2026-11-13&need=z_steals,z_blocks',
    );
    expect(pickupsPath('wnba', { open: ['2026-07-01'], need: [] })).toBe('/streamers/?league=wnba&open=2026-07-01');
  });

  it('a link it writes reads back to the same needs and days', () => {
    const url = new URL(`https://x.test${pickupsPath('nba', { week: true, open: ['2026-11-12'], need: ['z_assists', 'z_field_goal_pct'] })}`);
    expect(needsFromParam(url.searchParams.get('need'))).toEqual(['z_assists', 'z_field_goal_pct']);
    expect(daysFromParam(url.searchParams.get('open'))).toEqual(['2026-11-12']);
  });

  it('sets or drops the needs in the current address, keeping the rest', () => {
    expect(withNeeds('https://x.test/streamers/?league=nba&window=week', ['z_steals', 'z_blocks'])).toBe(
      'https://x.test/streamers/?league=nba&window=week&need=z_steals,z_blocks',
    );
    expect(withNeeds('https://x.test/streamers/?league=nba&need=z_steals', [])).toBe('https://x.test/streamers/?league=nba');
  });
});
