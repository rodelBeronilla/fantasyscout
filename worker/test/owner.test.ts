// The owner's sign-in callback against a stand-in for Yahoo's token endpoint: only the owner's
// Yahoo account gets the owner's cookie, and any other account is shown its id.
import { describe, expect, it } from 'vitest';
import { ciReaderKey, handleOwner, isOwner } from '../src/owner';

const ORIGIN = 'https://fantasyscout.example';
const ENV = { YAHOO_CLIENT_ID: 'client-id', YAHOO_CLIENT_SECRET: 'client-secret', OWNER_YAHOO_GUID: 'OWNERGUID' };

/** Yahoo's token reply to an OpenID sign-in: the account is the ID token's subject. */
const idToken = (sub: string) => `eyJhbGciOiJFUzI1NiJ9.${btoa(JSON.stringify({ sub })).replace(/=+$/, '')}.sig`;
const yahooAs = (guid?: string) => async (url: string) =>
  url.includes('/openid/v1/userinfo')
    ? new Response('no', { status: 401 })
    : Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, ...(guid ? { id_token: idToken(guid) } : {}) });
const callback = (state: string, cookieState = state) =>
  new Request(`${ORIGIN}/auth/yahoo/callback?code=c&state=${state}`, { headers: { cookie: `fs_owner_state=${cookieState}` } });
const ownerCookie = (res: Response) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith('fs_owner='))
    ?.split(';')[0];

describe("the owner's sign-in", () => {
  it("gives the owner's Yahoo account the owner's cookie, and the cookie opens the tables", async () => {
    const res = (await handleOwner(callback('owner-abc'), ENV, yahooAs('OWNERGUID')))!;
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/sql/');
    const cookie = ownerCookie(res)!;
    expect(cookie).toMatch(/^fs_owner=\d+\.[\w-]+$/);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('fs_owner_state=;') && c.includes('Max-Age=0'))).toBe(true);
    expect(await isOwner(new Request(ORIGIN, { headers: { cookie } }), ENV)).toBe(true);
    expect(await isOwner(new Request(ORIGIN, { headers: { cookie } }), { ...ENV, OWNER_YAHOO_GUID: 'OTHER' })).toBe(false);
  });

  it('shows any other account its id and opens nothing', async () => {
    const res = (await handleOwner(callback('owner-abc'), ENV, yahooAs('SOMEONE')))!;
    expect(res.headers.get('location')).toBe('/sql/?signin=notowner&account=SOMEONE');
    expect(ownerCookie(res)).toBeUndefined();
    const unnamed = (await handleOwner(callback('owner-abc'), { ...ENV, OWNER_YAHOO_GUID: undefined }, yahooAs('ME')))!;
    expect(unnamed.headers.get('location')).toBe('/sql/?signin=notowner&account=ME');
  });

  it('refuses a forged state, says when Yahoo names no account, and leaves other callbacks to the import', async () => {
    expect((await handleOwner(callback('owner-abc', 'owner-xyz'), ENV, yahooAs('OWNERGUID')))!.headers.get('location')).toBe('/sql/?signin=failed');
    expect((await handleOwner(callback('owner-abc'), ENV, yahooAs()))!.headers.get('location')).toBe(
      '/sql/?signin=noid&fields=access_token%2Cexpires_in%2Crefresh_token',
    );
    const failing = async () => new Response('no', { status: 400 });
    expect((await handleOwner(callback('owner-abc'), ENV, failing))!.headers.get('location')).toBe('/sql/?signin=failed');
    expect(await handleOwner(new Request(`${ORIGIN}/auth/yahoo/callback?code=c&state=s`), ENV)).toBeNull();
  });

  it("accepts CI's reader key, derived from the client secret, and nothing else", async () => {
    const key = await ciReaderKey('client-secret');
    // The same value notebooks/fs.py derives: hmac.new(b"client-secret", b"fantasyscout ci reader", sha256).
    expect(key).toBe('560bdfa3d8d216e4525631d090a13d1d1c28521d05cd8221feb99d5465157410');
    expect(await isOwner(new Request(ORIGIN, { headers: { authorization: `Bearer ${key}` } }), ENV)).toBe(true);
    expect(await isOwner(new Request(ORIGIN, { headers: { authorization: 'Bearer client-secret' } }), ENV)).toBe(false);
    expect(await isOwner(new Request(ORIGIN, { headers: { authorization: `Bearer ${key}` } }), {})).toBe(false);
  });

  it('reads the account from the OpenID token when Yahoo sends one', async () => {
    const claims = btoa(JSON.stringify({ sub: 'OWNERGUID', iss: 'https://api.login.yahoo.com' })).replace(/=+$/, '');
    const withIdToken = async () => Response.json({ access_token: 'a', expires_in: 3600, id_token: `eyJhbGciOiJFUzI1NiJ9.${claims}.sig` });
    const res = (await handleOwner(callback('owner-abc'), ENV, withIdToken))!;
    expect(res.headers.get('location')).toBe('/sql/');
    expect(ownerCookie(res)).toMatch(/^fs_owner=/);
  });

  it("falls back to Yahoo's OpenID user info for the account", async () => {
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      return url.includes('/openid/v1/userinfo') ? Response.json({ sub: 'SOMEONE' }) : Response.json({ access_token: 'a', expires_in: 3600 });
    };
    const res = (await handleOwner(callback('owner-abc'), ENV, fetcher))!;
    expect(res.headers.get('location')).toBe('/sql/?signin=notowner&account=SOMEONE');
    expect(calls.at(-1)).toBe('https://api.login.yahoo.com/openid/v1/userinfo');
  });

  it("passes Yahoo's refusal on, and always asks for the OpenID scope", async () => {
    const refused = new Request(`${ORIGIN}/auth/yahoo/callback?error=invalid_scope&error_description=Scope%20not%20allowed&state=owner-abc`, {
      headers: { cookie: 'fs_owner_state=owner-abc' },
    });
    expect((await handleOwner(refused, ENV))!.headers.get('location')).toBe('/sql/?signin=yahooerror&detail=Scope%20not%20allowed');
    const start = (await handleOwner(new Request(`${ORIGIN}/auth/owner/start`), ENV))!;
    expect(new URL(start.headers.get('location')!).searchParams.get('scope')).toBe('openid');
  });
});
