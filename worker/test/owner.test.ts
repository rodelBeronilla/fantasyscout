// The owner's sign-in callback against a stand-in for Yahoo's token endpoint: only the owner's
// Yahoo account gets the owner's cookie, and any other account is shown its id.
import { describe, expect, it } from 'vitest';
import { ciReaderKey, handleOwner, isOwner } from '../src/owner';

const ORIGIN = 'https://fantasyscout.example';
const ENV = { YAHOO_CLIENT_ID: 'client-id', YAHOO_CLIENT_SECRET: 'client-secret', OWNER_YAHOO_GUID: 'OWNERGUID' };

const yahooAs = (guid?: string) => async () => Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, ...(guid ? { xoauth_yahoo_guid: guid } : {}) });
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
    expect((await handleOwner(callback('owner-abc'), ENV, yahooAs()))!.headers.get('location')).toBe('/sql/?signin=noid');
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
});
