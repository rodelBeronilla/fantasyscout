/**
 * The shape of an event in the owner's log (#1032), the limits on each field, and the rule a batch
 * of the owner preview's calls is stored by (#1056). The Worker stores by it (owner-log.ts), the web
 * app builds its calls to it (owner-preview.ts), and the preview's tests answer as the Worker would
 * from it (web/tests/owner-preview.spec.ts), so the three cannot drift. No imports: it runs in the
 * Worker, the browser and Node alike.
 */

/** The longest string a call's fields may hold, in characters. */
export const CALL_LIMITS = { call: 40, subject: 120, value: 200, build: 64, league: 64 } as const;

/** A batch of the preview's calls: at most this many calls, in a request of at most this many bytes. */
export const BATCH_LIMITS = { calls: 60, bytes: 64 * 1024 } as const;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const short = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 10_000;
const onlyKeys = (o: Json, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

const isRoster = (v: unknown) => Array.isArray(v) && v.length <= 80 && v.every((id) => short(id, 64));
const isRecord = (v: unknown) =>
  v === null ||
  (isObject(v) && onlyKeys(v, ['wins', 'losses', 'ties', 'seed']) && count(v['wins']) && count(v['losses']) && count(v['ties']) && (v['seed'] === null || count(v['seed'])));
const isSlots = (v: unknown) => isObject(v) && Object.keys(v).length <= 2000 && Object.entries(v).every(([id, slot]) => short(id, 64) && short(slot, 16));
const isValue = (v: unknown) => (typeof v === 'number' && Number.isFinite(v)) || short(v, CALL_LIMITS.value);

/** The event as it is stored, or null when it is not one of the three kinds in their shapes. */
export function validEvent(v: unknown): Json | null {
  if (!isObject(v)) return null;
  switch (v['kind']) {
    case 'page':
      return onlyKeys(v, ['kind', 'path']) && short(v['path'], 300) && v['path'].startsWith('/') ? { kind: 'page', path: v['path'] } : null;
    case 'import': {
      const { host, mine, time, rosters, slots, records } = v;
      const ok =
        onlyKeys(v, ['kind', 'host', 'mine', 'time', 'rosters', 'slots', 'records']) &&
        (host === 'yahoo' || host === 'espn') &&
        (mine === null || count(mine)) &&
        typeof time === 'number' &&
        Number.isFinite(time) &&
        time > 0 &&
        Array.isArray(rosters) &&
        rosters.length <= 40 &&
        rosters.every(isRoster) &&
        isSlots(slots) &&
        Array.isArray(records) &&
        records.length <= 40 &&
        records.every(isRecord);
      return ok ? { kind: 'import', host, mine, time, rosters, slots, records } : null;
    }
    case 'call': {
      const { date, call, subject, value, naive, build } = v;
      const ok =
        onlyKeys(v, ['kind', 'date', 'call', 'subject', 'value', 'naive', 'build']) &&
        typeof date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        short(call, CALL_LIMITS.call) &&
        /^[a-z0-9-]+$/.test(call) &&
        short(subject, CALL_LIMITS.subject) &&
        isValue(value) &&
        (naive === null || isValue(naive)) &&
        short(build, CALL_LIMITS.build) &&
        /^[\w.:-]+$/.test(build);
      return ok ? { kind: 'call', date, call, subject, value, naive, build } : null;
    }
    default:
      return null;
  }
}

/**
 * One of the owner preview's calls in a batch (#1056): a call event with the league's import it was
 * made for (`league`: the host, league and import time, or "none" for a league entered by hand).
 */
export function validCall(v: unknown): Json | null {
  if (!isObject(v)) return null;
  const { league, ...rest } = v;
  const call = validEvent({ ...rest, kind: 'call' });
  return call && !('kind' in v) && short(league, CALL_LIMITS.league) && /^[\w.:-]+$/.test(league) ? { ...call, league } : null;
}

/**
 * The key the log keeps one entry under (#1056): the call, what it is about, the day, the league's
 * import, and what it said. A page opened again, or in a second tab, shows the same calls under the
 * same keys and adds nothing; a call that says something new is a new call shown.
 */
export function callKey(call: object): string {
  const c = call as Json;
  return JSON.stringify([c['date'], c['league'], c['call'], c['subject'], c['value'], c['naive']]);
}

/** What became of each call in a batch: stored now, kept (the log held it already), or refused (out of its shape). */
export type CallResult = 'stored' | 'kept' | 'refused';

/**
 * What a batch stores, given the keys the log holds already: each call's result, in order, and the
 * calls to write. Null when the body is not a batch ({ kind: "calls", calls: [...] }, 1 to
 * BATCH_LIMITS.calls of them).
 */
export function planBatch(body: unknown, have: ReadonlySet<string>): { results: CallResult[]; write: Json[] } | null {
  if (!isObject(body) || !onlyKeys(body, ['kind', 'calls']) || body['kind'] !== 'calls') return null;
  const calls = body['calls'];
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > BATCH_LIMITS.calls) return null;
  const seen = new Set(have);
  const write: Json[] = [];
  const results = calls.map((c): CallResult => {
    const call = validCall(c);
    if (!call) return 'refused';
    const key = callKey(call);
    if (seen.has(key)) return 'kept';
    seen.add(key);
    write.push(call);
    return 'stored';
  });
  return { results, write };
}

/** The keys of the calls a log file's lines hold (JSON Lines; a line that is not a call is skipped). */
export function keysIn(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isObject(v) && v['kind'] === 'call' && 'league' in v) keys.add(callKey(v));
    } catch {
      // a line that is not JSON holds no call
    }
  }
  return keys;
}
