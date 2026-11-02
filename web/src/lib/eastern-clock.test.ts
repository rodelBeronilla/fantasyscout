import { describe, expect, it } from 'vitest';

import { easternClock } from './format';

describe('the report time in Eastern time', () => {
  it('shows an instant as the Eastern wall clock, across the clock change', () => {
    expect(easternClock('2026-10-29T22:45:00+00:00')).toBe('18:45'); // EDT, UTC-4
    expect(easternClock('2026-11-02T16:15:00+00:00')).toBe('11:15'); // EST, UTC-5
    expect(easternClock('not a time')).toBe('');
  });
});
