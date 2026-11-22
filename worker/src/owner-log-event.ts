/**
 * The shape of an event in the owner's log (#1032), and the limits on each field: the one rule the
 * Worker stores by (owner-log.ts) and the web app's tests hold every call the owner preview posts
 * to (web/tests/owner-preview.spec.ts, #1056), so the two cannot drift. No imports: it runs in the
 * Worker and in Node alike.
 */

/** The longest string a call's fields may hold, in characters. */
export const CALL_LIMITS = { call: 40, subject: 120, value: 200, build: 64 } as const;

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
