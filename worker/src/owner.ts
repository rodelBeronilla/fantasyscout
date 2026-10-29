/**
 * The owner's sign-in, which keeps the bulk data private (ADR 0008). The derived pages stay
 * public. The published Parquet tables (the comprehensive statistics that the SQL console and
 * the notebooks query) are served only to the owner:
 *
 *  - in a browser, after signing in with the owner's Yahoo account: the Yahoo app's OAuth
 *    sign-in names the account (xoauth_yahoo_guid), and only OWNER_YAHOO_GUID gets the
 *    owner's cookie (HMAC-signed, HttpOnly). No Yahoo token is kept;
 *  - in CI, with a reader key derived from the Yahoo client secret, which CI holds as an
 *    Actions secret: HMAC-SHA256(secret, "fantasyscout ci reader"), hex.
 *
 *   GET /auth/owner/start      -> Yahoo's sign-in, with a state value held in a cookie
 *   GET /auth/yahoo/callback   -> (with that state) check the account, set the owner's cookie
 *   GET /auth/owner/logout     -> clear the cookie
 *   GET /api/owner/status      -> { configured, owner }
 *
 * The callback is the Yahoo app's one registered redirect URI, shared with the league import
 * (yahoo.ts); the owner's state cookie tells the two apart. Without the Yahoo app's credentials
 * nobody is the owner and the Parquet tables are served to no one.
 */
import { AUTH_URL, type Credentials, type Fetcher, readCookie, tokenRequest } from './yahoo';

export interface OwnerEnv {
  YAHOO_CLIENT_ID?: string;
  YAHOO_CLIENT_SECRET?: string;
  /** The owner's Yahoo account id; until it is set, signing in shows the account's id. */
  OWNER_YAHOO_GUID?: string;
}

const COOKIE = 'fs_owner';
const STATE_COOKIE = 'fs_owner_state';
const SESSION_DAYS = 30;
const CI_READER = 'fantasyscout ci reader';
/** The comprehensive tables: every Parquet file under /data/. The JSON the pages read stays public. */
const PRIVATE_DATA = /^\/data\/.+\.parquet$/i;

/** Judged on the decoded path, the key the data route serves, so an escaped name cannot slip past. */
export function isPrivateData(pathname: string): boolean {
  try {
    return PRIVATE_DATA.test(decodeURIComponent(pathname));
  } catch {
    return true;
  }
}

const credentials = (env: OwnerEnv): Credentials | null =>
  env.YAHOO_CLIENT_ID && env.YAHOO_CLIENT_SECRET ? { YAHOO_CLIENT_ID: env.YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET: env.YAHOO_CLIENT_SECRET } : null;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

/** The key CI reads the tables with; the same derivation as notebooks/fs.py. */
export async function ciReaderKey(secret: string): Promise<string> {
  return hex(await hmac(secret, CI_READER));
}

/** Compares two strings in time that does not depend on where they differ. */
async function same(a: string, b: string, secret: string): Promise<boolean> {
  const [x, y] = await Promise.all([hmac(secret, `cmp:${a}`), hmac(secret, `cmp:${b}`)]);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function sessionCookie(secret: string, guid: string, now = Date.now()): Promise<string> {
  const expires = now + SESSION_DAYS * 86_400_000;
  return `${expires}.${b64url(await hmac(secret, `owner:${guid}:${expires}`))}`;
}

export async function isOwner(request: Request, env: OwnerEnv, now = Date.now()): Promise<boolean> {
  const creds = credentials(env);
  if (!creds) return false;
  const secret = creds.YAHOO_CLIENT_SECRET;
  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return same(auth.slice(7), await ciReaderKey(secret), secret);
  const guid = env.OWNER_YAHOO_GUID;
  const value = readCookie(request, COOKIE);
  if (!guid || !value) return false;
  const [expires, mac] = value.split('.');
  if (!expires || !mac || !(Number(expires) > now)) return false;
  return same(mac, b64url(await hmac(secret, `owner:${guid}:${expires}`)), secret);
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}

/** Handles the owner routes; anything else returns null. */
export async function handleOwner(request: Request, env: OwnerEnv, fetcher: Fetcher = fetch): Promise<Response | null> {
  const url = new URL(request.url);
  const creds = credentials(env);
  if (url.pathname === '/api/owner/status') {
    return new Response(JSON.stringify({ configured: !!creds, owner: await isOwner(request, env) }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  if (url.pathname === '/auth/owner/logout') return redirect('/sql/', [cookie(COOKIE, '', 0)]);

  if (url.pathname === '/auth/owner/start') {
    if (!creds) return redirect('/sql/?signin=unavailable');
    const state = `owner-${b64url(crypto.getRandomValues(new Uint8Array(16)))}`;
    const auth = new URL(AUTH_URL);
    auth.search = new URLSearchParams({
      client_id: creds.YAHOO_CLIENT_ID,
      redirect_uri: `${url.origin}/auth/yahoo/callback`,
      response_type: 'code',
      state,
    }).toString();
    return redirect(auth.toString(), [cookie(STATE_COOKIE, state, 600)]);
  }

  // The shared Yahoo callback is the owner's only when it carries the owner's state.
  const expected = readCookie(request, STATE_COOKIE);
  if (url.pathname !== '/auth/yahoo/callback' || !expected) return null;
  const clearState = cookie(STATE_COOKIE, '', 0);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!creds || !code || state !== expected) return redirect('/sql/?signin=failed', [clearState]);
  let guid: string | undefined;
  try {
    ({ guid } = await tokenRequest(creds, { grant_type: 'authorization_code', code, redirect_uri: `${url.origin}/auth/yahoo/callback` }, fetcher));
  } catch {
    return redirect('/sql/?signin=failed', [clearState]);
  }
  if (!guid) return redirect('/sql/?signin=noid', [clearState]);
  if (!env.OWNER_YAHOO_GUID || guid !== env.OWNER_YAHOO_GUID) {
    // Not the owner, or no owner named yet: show the account's id, which the owner sets once.
    return redirect(`/sql/?signin=notowner&account=${encodeURIComponent(guid)}`, [clearState]);
  }
  return redirect('/sql/', [clearState, cookie(COOKIE, await sessionCookie(creds.YAHOO_CLIENT_SECRET, guid), SESSION_DAYS * 86_400)]);
}
