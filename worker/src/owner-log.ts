/**
 * The owner's log (#1032): a private record of the owner's own use of the site, which he approved
 * on 2026-11-17, written only while he is signed in as the owner. Each event is one JSON line in
 * one file a day (the Eastern date) under PRIVATE_PREFIX, which the public data route never
 * serves. Only the owner's session cookie opens these routes; CI's reader key does not.
 *
 *   POST   /api/owner/log  -> append one event (a page opened, an import, a call shown), or a
 *                              batch of the owner preview's calls (#1056), answered call by call
 *   GET    /api/owner/log  -> download every day's file, oldest first, as one JSON Lines file
 *   DELETE /api/owner/log  -> delete every day's file
 */
import { PRIVATE_PREFIX } from './account';
import { hasOwnerCookie, type OwnerEnv } from './owner';
import { BATCH_LIMITS, keysIn, planBatch, validEvent } from './owner-log-event';

interface OwnerLogEnv extends OwnerEnv {
  DATA: R2Bucket;
}

const PATH = '/api/owner/log';
/** Where the days' files live in the bucket: under the prefix the /data/ route answers 404 for. */
const LOG_PREFIX = `${PRIVATE_PREFIX}owner-log/`;
/** One event: an import of a 20-team league's rosters, slots and records is well under this. */
const MAX_EVENT_BYTES = 64 * 1024;
/** A day's file stops growing here: hundreds of pages and dozens of imports a day fit. */
const MAX_DAY_BYTES = 4 * 1024 * 1024;

/** The methods the log takes beyond GET; the Worker otherwise answers GET and HEAD only. */
export function isOwnerLogWrite(request: Request): boolean {
  return new URL(request.url).pathname === PATH && (request.method === 'POST' || request.method === 'DELETE');
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
  });
}

/** The Eastern date of a moment, YYYY-MM-DD: the day's file an event goes in. */
export function easternDay(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(
    new Date(ms),
  );
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

const DAY_MS = 86_400_000;
/** How often a batch reads and writes again after losing a race: every writer at once but one wins each round. */
const BATCH_TRIES = 8;

/**
 * Stores a batch of the owner preview's calls (#1056) in one write to the day's calls file, beside
 * the day's file of events: each call once by its key (callKey), so a page opened again or a second
 * tab adds nothing. The file is created only if absent and replaced only if unchanged since it was
 * read, so two batches at once never lose a call: the one that lost the race reads again and retries.
 */
async function storeBatch(env: OwnerLogEnv, body: unknown, now: number): Promise<Response> {
  const file = (ms: number) => `${LOG_PREFIX}${easternDay(ms)}.calls.jsonl`;
  // yesterday's calls too: a view just after midnight on one clock and just before on the other is one view
  const yesterday = await env.DATA.get(file(now - DAY_MS));
  const before = yesterday ? keysIn(await yesterday.text()) : new Set<string>();
  for (let attempt = 0; attempt < BATCH_TRIES; attempt += 1) {
    // a write that lost the race waits a moment, a little longer each time, before it reads again
    if (attempt > 0) await new Promise((done) => setTimeout(done, Math.random() * 20 * attempt));
    const current = await env.DATA.get(file(now));
    const text = current ? await current.text() : '';
    const plan = planBatch(body, new Set([...before, ...keysIn(text)]));
    if (!plan) return json(400, { error: `expected a batch of 1 to ${BATCH_LIMITS.calls} calls` });
    if (plan.write.length === 0) return json(200, { results: plan.results });
    const at = new Date(now).toISOString();
    const lines = plan.write.map((c) => `${JSON.stringify({ at, kind: 'call', ...c })}\n`).join('');
    if (text.length + lines.length > MAX_DAY_BYTES) return json(413, { error: "today's log is full" });
    const options: R2PutOptions = {
      httpMetadata: { contentType: 'application/x-ndjson' },
      onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' },
    };
    if (await env.DATA.put(file(now), text + lines, options)) return json(200, { results: plan.results });
  }
  return json(503, { error: 'try again' });
}

/** Every day's file, oldest first (the keys sort by date). */
async function logKeys(env: OwnerLogEnv): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.DATA.list({ prefix: LOG_PREFIX, cursor, limit: 1000 });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

/** Appends a line to the day's file; R2 has no append, so a write that lost a race is tried again. */
async function append(env: OwnerLogEnv, key: string, line: string): Promise<'ok' | 'full' | 'busy'> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await env.DATA.get(key);
    const before = current ? await current.text() : '';
    if (before.length + line.length > MAX_DAY_BYTES) return 'full';
    const options: R2PutOptions = { httpMetadata: { contentType: 'application/x-ndjson' } };
    if (current) options.onlyIf = { etagMatches: current.etag };
    if (await env.DATA.put(key, before + line, options)) return 'ok';
  }
  return 'busy';
}

/** Handles the log's routes; anything else returns null. */
export async function handleOwnerLog(request: Request, env: OwnerLogEnv, now = Date.now()): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PATH) return null;
  // the owner's browser alone: nothing below runs, and nothing is written, without the cookie
  if (!(await hasOwnerCookie(request, env, now))) return json(401, { error: 'the owner only' });

  if (request.method === 'POST' || request.method === 'DELETE') {
    // writes come from this site's own pages, never a cross-site form or script
    if (request.headers.get('origin') !== url.origin) return json(403, { error: 'cross-site write' });
  }

  if (request.method === 'POST') {
    if (!(request.headers.get('content-type') ?? '').includes('application/json')) return json(415, { error: 'JSON only' });
    if (Number(request.headers.get('content-length') ?? 0) > MAX_EVENT_BYTES) return json(413, { error: 'event too large' });
    const body = await request.text();
    if (body.length > MAX_EVENT_BYTES) return json(413, { error: 'event too large' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return json(400, { error: 'not JSON' });
    }
    if (typeof parsed === 'object' && parsed !== null && (parsed as { kind?: unknown }).kind === 'calls') return storeBatch(env, parsed, now);
    const event = validEvent(parsed);
    if (!event) return json(400, { error: 'expected a page, import or call event' });
    const day = easternDay(now);
    const written = await append(env, `${LOG_PREFIX}${day}.jsonl`, `${JSON.stringify({ at: new Date(now).toISOString(), ...event })}\n`);
    if (written === 'full') return json(413, { error: "today's log is full" });
    if (written === 'busy') return json(503, { error: 'try again' });
    return json(200, { logged: true, day });
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    const keys = await logKeys(env);
    const headers = {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'private, no-store',
      'content-disposition': `attachment; filename="fantasyscout-owner-log-${easternDay(now)}.jsonl"`,
    };
    if (request.method === 'HEAD') return new Response(null, { headers });
    // one day's file in memory at a time
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const key = keys.shift();
        if (key === undefined) {
          controller.close();
          return;
        }
        const object = await env.DATA.get(key);
        if (object) controller.enqueue(new Uint8Array(await object.arrayBuffer()));
      },
    });
    return new Response(body, { headers });
  }

  if (request.method === 'DELETE') {
    let deleted = 0;
    // listed again until nothing is left, so a day written during the delete goes too
    for (let pass = 0, keys = await logKeys(env); keys.length && pass < 5; pass += 1, keys = await logKeys(env)) {
      for (let i = 0; i < keys.length; i += 1000) await env.DATA.delete(keys.slice(i, i + 1000));
      deleted += keys.length;
    }
    return json(200, { deleted: true, days: deleted });
  }

  return json(405, { error: 'method not allowed' });
}
