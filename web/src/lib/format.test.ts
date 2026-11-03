import { describe, expect, it } from 'vitest';

import { lineupDay } from '../components/ui';
import { day, easternClock, when } from './format';
import { easternDate } from './today';

// The formatters are built once (#557); each must print what the per-call toLocale* form printed.
const INSTANTS = ['2026-01-05T00:30:00Z', '2026-03-08T07:15:00Z', '2026-07-04T23:59:00Z', '2026-11-01T05:30:00Z', '2026-12-31T12:00:00Z'];

describe('cached date formatters', () => {
  it('print exactly what toLocaleDateString and its kin printed', () => {
    for (const iso of INSTANTS) {
      const d = new Date(iso);
      expect(day(iso)).toBe(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }));
      expect(day(iso.slice(0, 10))).toBe(new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }));
      expect(when(iso)).toBe(
        d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false }) + ' UTC',
      );
      expect(easternClock(iso)).toBe(d.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }));
      expect(easternDate(d)).toBe(d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));
    }
  });

  it('keep their edge cases', () => {
    expect(day(null)).toBe('–');
    expect(day('not a date')).toBe('not a date');
    expect(when(undefined)).toBe('–');
    expect(easternClock('2026-01-05T18:45:00-bad')).toBe('18:45');
    expect(easternDate(new Date('2026-11-03T03:00:00Z'))).toBe('2026-11-02');
  });

  it('name a lineup day today or by its weekday and date', () => {
    expect(lineupDay(null)).toBe('today');
    expect(lineupDay(easternDate())).toBe('today');
    expect(lineupDay('2026-11-05')).toBe('Thu, Nov 5');
  });
});
