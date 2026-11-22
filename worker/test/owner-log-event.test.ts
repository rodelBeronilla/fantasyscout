import { describe, expect, it } from 'vitest';

import { CALL_LIMITS, validEvent } from '../src/owner-log-event';

const call = { kind: 'call', date: '2026-11-02', call: 'trade-finder', subject: '1628983 > 1630178', value: '+0.40 categories', naive: null, build: 'fixture' };

describe("a call in the owner's log (#1032, #1056)", () => {
  it('is stored as sent when every field is within its limit', () => {
    expect(validEvent(call)).toEqual(call);
    const longest = { ...call, call: 'a'.repeat(CALL_LIMITS.call), subject: 's'.repeat(CALL_LIMITS.subject), value: 'v'.repeat(CALL_LIMITS.value), build: 'b'.repeat(CALL_LIMITS.build) };
    expect(validEvent(longest)).toEqual(longest);
  });

  it('is refused one character past any limit, empty, or with a field it does not know', () => {
    expect(validEvent({ ...call, subject: 's'.repeat(CALL_LIMITS.subject + 1) })).toBeNull();
    expect(validEvent({ ...call, value: 'v'.repeat(CALL_LIMITS.value + 1) })).toBeNull();
    expect(validEvent({ ...call, naive: 'v'.repeat(CALL_LIMITS.value + 1) })).toBeNull();
    expect(validEvent({ ...call, call: 'a'.repeat(CALL_LIMITS.call + 1) })).toBeNull();
    expect(validEvent({ ...call, build: 'b'.repeat(CALL_LIMITS.build + 1) })).toBeNull();
    expect(validEvent({ ...call, subject: '' })).toBeNull();
    expect(validEvent({ ...call, call: 'Trade Finder' })).toBeNull();
    expect(validEvent({ ...call, extra: 1 })).toBeNull();
  });
});
