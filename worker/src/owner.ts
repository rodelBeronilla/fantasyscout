/**
 * The owner's sign-in, which keeps the bulk data private (ADR 0008). The derived pages stay
 * public. The published Parquet tables (the comprehensive statistics that the SQL console and
 * the notebooks query) are served only to the owner: a browser that signed in with OWNER_KEY
 * (an HMAC-signed, HttpOnly cookie), or CI sending it as a bearer token.
 *
 *   POST /auth/owner          -> check the key, set the cookie, back to the SQL console
 *   GET  /auth/owner/logout   -> clear the cookie
 *   GET  /api/owner/status    -> { configured, owner }
 *
 * Without OWNER_KEY set, nobody is the owner and the Parquet tables are served to no one.
 */
import { readCookie } from './yahoo';

export interface OwnerEnv {
  OWNER_KEY?: string;
}

const COOKIE = 'fs_owner';
const SESSION_DAYS = 30;
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

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sessionKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('fantasyscout owner session') },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

async function sign(secret: string, payload: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await sessionKey(secret), new TextEncoder().encode(payload));
  return b64url(new Uint8Array(mac));
}

/** Compares two strings in time that does not depend on where they differ. */
async function sameSecret(given: string, secret: string): Promise<boolean> {
  const [a, b] = await Promise.all([sign(secret, `cmp:${given}`), sign(secret, `cmp:${secret}`)]);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sessionCookie(secret: string, now = Date.now()): Promise<string> {
  const expires = now + SESSION_DAYS * 86_400_000;
  return `${expires}.${await sign(secret, `session:${expires}`)}`;
}

export async function isOwner(request: Request, env: OwnerEnv, now = Date.now()): Promise<boolean> {
  const secret = env.OWNER_KEY;
  if (!secret) return false;
  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return sameSecret(auth.slice(7), secret);
  const value = readCookie(request, COOKIE);
  if (!value) return false;
  const [expires, mac] = value.split('.');
  if (!expires || !mac || !(Number(expires) > now)) return false;
  return (await sign(secret, `session:${expires}`)) === mac;
}

function cookie(value: string, maxAge: number): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function seeOther(location: string, setCookie?: string): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  if (setCookie) headers.set('set-cookie', setCookie);
  return new Response(null, { status: 303, headers });
}

/** Where to go after signing in: a path on this site only. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/sql/';
}

/** Handles the owner routes; anything else returns null. */
export async function handleOwner(request: Request, env: OwnerEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/api/owner/status') {
    return new Response(JSON.stringify({ configured: !!env.OWNER_KEY, owner: await isOwner(request, env) }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  if (url.pathname === '/auth/owner/logout') return seeOther('/sql/', cookie('', 0));
  if (url.pathname !== '/auth/owner') return null;
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  // A sign-in form posted from another site is refused.
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return new Response('Forbidden', { status: 403 });
  const form = await request.formData().catch(() => null);
  const key = form?.get('key');
  const next = safeNext(typeof form?.get('next') === 'string' ? (form.get('next') as string) : null);
  if (!env.OWNER_KEY || typeof key !== 'string' || !(await sameSecret(key, env.OWNER_KEY))) {
    return seeOther(`${next}${next.includes('?') ? '&' : '?'}signin=failed`);
  }
  return seeOther(next, cookie(await sessionCookie(env.OWNER_KEY), SESSION_DAYS * 86_400));
}
