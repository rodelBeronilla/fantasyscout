import { describe, expect, it } from 'vitest';

import { nextSeason } from './format';

describe('nextSeason', () => {
  it('names the season after a WNBA year or an NBA span', () => {
    expect(nextSeason('2026')).toBe('2027');
    expect(nextSeason('2025-26')).toBe('2026-27');
    expect(nextSeason('2099-00')).toBe('2100-01');
    expect(nextSeason('')).toBeNull();
    expect(nextSeason(null)).toBeNull();
    expect(nextSeason('spring')).toBeNull();
  });
});
