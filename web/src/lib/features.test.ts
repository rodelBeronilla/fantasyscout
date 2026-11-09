import { describe, expect, it } from 'vitest';

import { FEATURES } from '../generated/features';
import { judgingDates, shownOf, SWITCHES, verdictRows } from './verdicts';

// The site's switch list and methodology/features.yml must agree (#947): a call is hidden exactly
// when its verdict is not a pass, so the Methodology table and the pages cannot drift apart.
const passes = (verdict: string) => verdict === 'validated' || verdict === 'data';

describe('the feature list and the switches', () => {
  it('names every switch once', () => {
    const named = FEATURES.flatMap((f) => (f.switch === undefined ? [] : [f.switch]));
    expect([...named].sort()).toEqual(Object.keys(SWITCHES).sort());
  });

  it('hides every switch whose feature has not passed, and shows every one that has', () => {
    for (const f of FEATURES.filter((x) => x.switch !== undefined)) {
      expect({ id: f.id, shows: SWITCHES[f.switch!] }).toEqual({ id: f.id, shows: passes(f.verdict) });
    }
  });

  it('shows an unjudged or failed feature without a switch only with a badge, but for the ones it names', () => {
    // the mid-week chances still show on My Team until #936 rule 8 hides them; the table says so
    const plain = FEATURES.filter((f) => f.switch === undefined && !passes(f.verdict) && shownOf(f) === 'shown').map((f) => f.id);
    expect(plain).toEqual(['midweek-chances']);
  });
});

describe('the verdict table', () => {
  it('leads with what passed and ends with the facts', () => {
    const order = verdictRows().map((r) => r.feature.verdict);
    expect(order[0]).toBe('validated');
    expect(order.at(-1)).toBe('data');
    expect(order).toEqual([...order].sort((a, b) => ['validated', 'failed', 'open', 'data'].indexOf(a) - ['validated', 'failed', 'open', 'data'].indexOf(b)));
  });

  it('reads a switch for whether a feature shows', () => {
    const f = FEATURES.find((x) => x.id === 'streams')!;
    expect(shownOf(f, { streams: false })).toBe('hidden');
    expect(shownOf(f, { streams: true })).toBe('shown');
  });

  it('names the board value ADR 0031 and how its numbers were set', () => {
    const row = verdictRows().find((r) => r.feature.id === 'board-value')!;
    expect(row.feature.adr).toBe(31);
    expect(row.numbers).toMatch(/\d+ measured/);
    expect(row.page).toEqual({ label: 'Rankings', path: '/' });
  });

  it('gives the week-level features their two looks', () => {
    const row = verdictRows().find((r) => r.feature.id === 'lineup')!;
    expect(row.next).toBe("On 2026-27's weeks: 18 January and 15 March 2027");
  });
});

describe('judgingDates', () => {
  it('names the year once when the dates share it', () => {
    expect(judgingDates(['2027-01-18', '2027-03-15'])).toBe('18 January and 15 March 2027');
    expect(judgingDates(['2026-12-28', '2027-01-04'])).toBe('28 December 2026 and 4 January 2027');
    expect(judgingDates(['2027-04-12'])).toBe('12 April 2027');
    expect(judgingDates([])).toBe('');
  });
});
