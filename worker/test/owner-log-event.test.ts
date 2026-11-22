import { describe, expect, it } from 'vitest';

import { BATCH_LIMITS, CALL_LIMITS, callKey, keysIn, planBatch, validCall, validEvent } from '../src/owner-log-event';

const call = { kind: 'call', date: '2026-11-02', call: 'trade-finder', subject: 'p1 p2 > p3', value: '+0.40 categories', naive: null, build: 'fixture' };

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

describe("a batch of the owner preview's calls (#1056)", () => {
  const one = { date: '2026-11-02', call: 'lineup', subject: 'p1', value: '12 starts', naive: null, build: 'fixture', league: 'yahoo:99:1762094400000' };

  it('takes a call with the league it was made for, in the call shape and its limits', () => {
    expect(validCall(one)).toEqual({ kind: 'call', ...one });
    expect(validCall({ ...one, league: 'l'.repeat(CALL_LIMITS.league) })).not.toBeNull();
    expect(validCall({ ...one, league: 'l'.repeat(CALL_LIMITS.league + 1) })).toBeNull();
    expect(validCall({ ...one, league: 'a league' })).toBeNull();
    expect(validCall({ ...one, league: undefined })).toBeNull();
    expect(validCall({ ...one, kind: 'call' })).toBeNull();
    expect(validCall({ ...one, value: '' })).toBeNull();
  });

  it('answers each call: stored, kept when the log or the batch holds its key, refused out of its shape', () => {
    const have = new Set([callKey({ ...one, subject: 'p0' })]);
    const plan = planBatch({ kind: 'calls', calls: [{ ...one, subject: 'p0' }, one, one, { ...one, subject: '' }] }, have);
    expect(plan?.results).toEqual(['kept', 'stored', 'kept', 'refused']);
    expect(plan?.write).toEqual([{ kind: 'call', ...one }]);
    // the key is what the call is and said: another day, league, value or naive answer is another call
    for (const other of [{ date: '2026-11-03' }, { league: 'yahoo:99:1' }, { value: '13 starts' }, { naive: 'x' }]) expect(callKey({ ...one, ...other })).not.toBe(callKey(one));
    expect(callKey({ ...one, build: 'another' })).toBe(callKey(one));
  });

  it('is 1 to BATCH_LIMITS.calls calls, or not a batch', () => {
    const calls = (n: number) => Array.from({ length: n }, (_, i) => ({ ...one, subject: `p${i}` }));
    expect(planBatch({ kind: 'calls', calls: calls(BATCH_LIMITS.calls) }, new Set())?.write).toHaveLength(BATCH_LIMITS.calls);
    for (const body of [{ kind: 'calls', calls: calls(BATCH_LIMITS.calls + 1) }, { kind: 'calls', calls: [] }, { kind: 'calls' }, { kind: 'calls', calls: calls(1), x: 1 }, calls(1), null])
      expect(planBatch(body, new Set())).toBeNull();
  });

  it("reads the keys of a file's calls, skipping other lines", () => {
    const text = `${JSON.stringify({ at: 'x', kind: 'call', ...one })}
{"kind":"page","path":"/"}
not json
${JSON.stringify(call)}
`;
    expect([...keysIn(text)]).toEqual([callKey({ kind: 'call', ...one })]);
  });
});
