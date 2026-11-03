/**
 * A manager's account (#684): signing in with Yahoo saves the League page's setups so they follow
 * the manager across devices. Any Yahoo account can sign in. The Worker never stores the Yahoo id:
 * the account is an HMAC of it under the client secret, carried in a signed, HttpOnly cookie, and
 * a setup is stored per league under that id in the R2 bucket, below a prefix the public data
 * route refuses to serve (PRIVATE_PREFIX).
 *
 *   GET    /auth/account/start?league=nba  -> Yahoo's OpenID sign-in (the owner's flow, owner.ts)
 *   GET    /auth/account/logout            -> forget the account cookie
 *   GET    /api/account/status             -> { configured, signedIn }
 *   GET    /api/account/setup?league=nba   -> { setup, savedAt } (both null when none is saved)
 *   PUT    /api/account/setup?league=nba   -> store { setup, savedAt }
 *   DELETE /api/account                    -> delete everything stored for the account
 */
import { readCookie } from './yahoo';

export interface AccountEnv {
  YAHOO_CLIENT_SECRET?: string;
  YAHOO_CLIENT_ID?: string;
  DATA: R2Bucket;
}

const COOKIE = 'fs_account';
const SESSION_DAYS = 90;
const LEAGUES = new Set(['nba', 'wnba']);
/** The most a stored setup may weigh: a 20-team league's rosters and settings are a few KB. */
const MAX_BYTES = 256 * 1024;
/** Where accounts live in the bucket. The /data/ route answers 404 below it (index.ts). */
export const PRIVATE_PREFIX = 'private/';
const accountPrefix = (id: string) => `${PRIVATE_PREFIX}accounts/${id}/`;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

/** The account's id: an HMAC of the Yahoo account id, so the bucket never holds the Yahoo id. */
async function accountId(secret: string, guid: string): Promise<string> {
  return hex(await hmac(secret, `account:${guid}`)).slice(0, 32);
}

/** The cookie that signs a browser in to an account. */
export async function accountCookie(secret: string, guid: string, now = Date.now()): Promise<string> {
  const id = await accountId(secret, guid);
  const expires = now + SESSION_DAYS * 86_400_000;
  const value = `${expires}.${id}.${b64url(await hmac(secret, `session:${id}:${expires}`))}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}`;
}

/** The account a request is signed in to, or null. */
async function signedInAccount(request: Request, env: AccountEnv, now = Date.now()): Promise<string | null> {
  const secret = env.YAHOO_CLIENT_SECRET;
  const value = readCookie(request, COOKIE);
  if (!secret || !value) return null;
  const [expires, id, mac] = value.split('.');
  if (!expires || !id || !mac || !/^[0-9a-f]{32}$/.test(id) || !(Number(expires) > now)) return null;
  const expected = b64url(await hmac(secret, `session:${id}:${expires}`));
  // compare in time that does not depend on where the two differ
  let diff = mac.length ^ expected.length;
  for (let i = 0; i < Math.min(mac.length, expected.length); i += 1) diff |= mac.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? id : null;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', ...headers },
  });
}

const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** The methods the account routes take; the Worker otherwise answers GET and HEAD only. */
export function isAccountWrite(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return (request.method === 'PUT' && pathname === '/api/account/setup') || (request.method === 'DELETE' && pathname === '/api/account');
}

/** Handles the account routes; anything else returns null. */
export async function handleAccount(request: Request, env: AccountEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (!pathname.startsWith('/api/account') && pathname !== '/auth/account/logout') return null;
  const configured = !!(env.YAHOO_CLIENT_ID && env.YAHOO_CLIENT_SECRET);

  if (pathname === '/auth/account/logout') {
    return new Response(null, { status: 302, headers: { location: '/league/', 'set-cookie': clearCookie, 'cache-control': 'no-store' } });
  }
  const id = await signedInAccount(request, env);
  if (pathname === '/api/account/status') return json(200, { configured, signedIn: !!id });
  if (!id) return json(401, { error: 'not signed in' });

  // Writes come from this site's own pages: a cross-site form or script is refused even though
  // the SameSite cookie would already stay behind.
  if (request.method === 'PUT' || request.method === 'DELETE') {
    const origin = request.headers.get('origin');
    if (origin !== url.origin) return json(403, { error: 'cross-site write' });
  }

  if (pathname === '/api/account' && request.method === 'DELETE') {
    const prefix = accountPrefix(id);
    let cursor: string | undefined;
    do {
      const page = await env.DATA.list({ prefix, cursor, limit: 1000 });
      if (page.objects.length) await env.DATA.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return json(200, { deleted: true }, { 'set-cookie': clearCookie });
  }

  if (pathname === '/api/account/setup') {
    const league = url.searchParams.get('league') ?? '';
    if (!LEAGUES.has(league)) return json(400, { error: 'unknown league' });
    const key = `${accountPrefix(id)}${league}.json`;
    if (request.method === 'GET' || request.method === 'HEAD') {
      const object = await env.DATA.get(key);
      if (!object) return json(200, { setup: null, savedAt: null });
      return json(200, await object.json());
    }
    if (request.method === 'PUT') {
      if (!(request.headers.get('content-type') ?? '').includes('application/json')) return json(415, { error: 'JSON only' });
      const body = await request.text();
      if (body.length > MAX_BYTES) return json(413, { error: 'setup too large' });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json(400, { error: 'not JSON' });
      }
      const p = parsed as { setup?: unknown; savedAt?: unknown };
      if (!p || typeof p !== 'object' || !p.setup || typeof p.setup !== 'object' || Array.isArray(p.setup) || typeof p.savedAt !== 'number') {
        return json(400, { error: 'expected { setup, savedAt }' });
      }
      await env.DATA.put(key, JSON.stringify({ setup: p.setup, savedAt: p.savedAt }), { httpMetadata: { contentType: 'application/json' } });
      return json(200, { saved: true, savedAt: p.savedAt });
    }
  }
  return json(405, { error: 'method not allowed' });
}
