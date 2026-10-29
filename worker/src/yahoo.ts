/**
 * Yahoo Fantasy import: the manager signs in to Yahoo (OAuth 2.0, authorization code), and the
 * League page reads their NBA leagues through the routes below. Tokens never reach the browser:
 * they live in an HttpOnly cookie, encrypted (AES-GCM) under a key derived from the client
 * secret, and the Worker calls Yahoo on the page's behalf.
 *
 *   /auth/yahoo/start             -> Yahoo's sign-in, with a state value held in a cookie
 *   /auth/yahoo/callback          -> code for tokens, then back to the League page
 *   /auth/yahoo/logout            -> forget the tokens
 *   /api/yahoo/status             -> { configured, connected }
 *   /api/yahoo/leagues            -> the manager's NBA leagues this season
 *   /api/yahoo/league/<key>       -> one league: settings, teams and rosters, by player name
 *
 * Yahoo has no WNBA game, so the import is NBA only. The import is live only with
 * YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET set as Worker secrets and the YAHOO_IMPORT variable
 * set to "on" (Yahoo must first approve the app for its Fantasy API). Until then the status
 * route says so and every other route is closed.
 */

export interface YahooEnv {
  YAHOO_CLIENT_ID?: string;
  YAHOO_CLIENT_SECRET?: string;
  /** "on" once Yahoo has approved the app; anything else keeps the import closed. */
  YAHOO_IMPORT?: string;
}

const AUTH_URL = 'https://api.login.yahoo.com/oauth2/request_auth';
const TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';
const API = 'https://fantasysports.yahooapis.com/fantasy/v2';
const TOKEN_COOKIE = 'fs_yahoo';
const STATE_COOKIE = 'fs_yahoo_state';
const RETURN_PATH = '/league/?league=nba';
/** Browsers drop cookies over 4 KB; past this the access token is left out and fetched again. */
const COOKIE_LIMIT = 3800;

export interface Tokens {
  refresh: string;
  access?: string;
  /** When the access token expires, in ms since the epoch. */
  expires?: number;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Requests from a Worker carry no User-Agent unless given one, and Yahoo's edge can turn those away. */
const USER_AGENT = 'FantasyScout/1.0 (+https://fantasyscout.beronilla.rodeo)';

/** What Yahoo said about a failed request: its JSON error description, or the page's text, kept short. */
export async function yahooError(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(body) as { error?: { description?: string } | string; error_description?: string };
    const described = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.description ?? parsed.error_description);
    if (described) return described.slice(0, 300);
  } catch {
    // not JSON: an XML or HTML error page
  }
  const text = body
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (text || res.statusText || 'no detail').slice(0, 300);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function cookieKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('fantasyscout yahoo token cookie') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealTokens(tokens: Tokens, secret: string): Promise<string> {
  const key = await cookieKey(secret);
  const seal = async (t: Tokens) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(t))));
    const out = new Uint8Array(iv.length + data.length);
    out.set(iv);
    out.set(data, iv.length);
    return b64url(out);
  };
  const full = await seal(tokens);
  return full.length <= COOKIE_LIMIT ? full : seal({ refresh: tokens.refresh });
}

export async function openTokens(sealed: string | null, secret: string): Promise<Tokens | null> {
  if (!sealed) return null;
  try {
    const bytes = fromB64url(sealed);
    const key = await cookieKey(secret);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    const tokens = JSON.parse(new TextDecoder().decode(plain)) as Tokens;
    return typeof tokens.refresh === 'string' ? tokens : null;
  } catch {
    // tampered, or sealed under a previous secret
    return null;
  }
}

async function tokenRequest(env: Credentials, body: Record<string, string>, fetcher: Fetcher): Promise<Tokens> {
  const res = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${env.YAHOO_CLIENT_ID}:${env.YAHOO_CLIENT_SECRET}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT,
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const detail = await yahooError(res);
    console.error(`yahoo token ${body['grant_type']}: ${res.status} ${detail}`);
    throw new Error(`Yahoo token request failed (${res.status}): ${detail}`);
  }
  const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  return {
    access: data.access_token,
    refresh: data.refresh_token ?? body['refresh_token'] ?? '',
    expires: Date.now() + Math.max(60, (data.expires_in ?? 3600) - 60) * 1000,
  };
}

/**
 * Yahoo's JSON wraps every list as {"0": …, "1": …, "count": n} and every resource as an array of
 * fragments ([{key: …}, {name: …}], {sub-resource}). This turns lists into arrays and merges the
 * fragments into one object, so the result reads like ordinary JSON.
 */
export function simplify(x: unknown): unknown {
  if (Array.isArray(x)) {
    const objects = x.filter((i) => i && typeof i === 'object' && !Array.isArray(i)) as Record<string, unknown>[];
    const first = objects[0] ? Object.keys(objects[0]) : [];
    const isList =
      objects.length === x.length && first.length === 1 && objects.every((o) => Object.keys(o).length === 1 && Object.keys(o)[0] === first[0]) && x.length > 1;
    if (isList) return x.map(simplify);
    const out: Record<string, unknown> = {};
    for (const item of x) {
      for (const part of Array.isArray(item) ? item : [item]) {
        if (part && typeof part === 'object' && !Array.isArray(part)) Object.assign(out, simplify(part));
      }
    }
    return out;
  }
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => k !== 'count');
    if ('count' in o && keys.every((k) => /^\d+$/.test(k))) return keys.sort((a, b) => Number(a) - Number(b)).map((k) => simplify(o[k]));
    return Object.fromEntries(Object.keys(o).map((k) => [k, simplify(o[k])]));
  }
  return x;
}

/** Every value stored under `key`, anywhere below `x`, outermost first. */
export function findAll(x: unknown, key: string): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) {
        if (k === key) out.push(child);
        else walk(child);
      }
    }
  };
  walk(x);
  return out;
}

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

export interface YahooLeagueSummary {
  key: string;
  name: string;
  season: string;
  teams: number;
}

export function parseLeagues(body: unknown): YahooLeagueSummary[] {
  return findAll(simplify(body), 'league').map((l) => {
    const league = l as Record<string, unknown>;
    return { key: str(league['league_key']), name: str(league['name']), season: str(league['season']), teams: Number(league['num_teams']) || 0 };
  });
}

/** Yahoo's NBA stat ids, for points leagues: stat id -> the board's point key. */
const POINT_STAT_IDS: Record<string, string> = {
  '12': 'points',
  '15': 'rebounds',
  '16': 'assists',
  '17': 'steals',
  '18': 'blocks',
  '10': 'threes',
  '19': 'turnovers',
  '4': 'fgm',
  '3': 'fga',
  '7': 'ftm',
  '6': 'fta',
};
const TURNOVERS = '19';
const INJURED_SLOTS = new Set(['IL', 'IL+', 'IR']);

export interface YahooLeague {
  key: string;
  name: string;
  season: string;
  settings: { teams: number; rosterSpots: number; scoring: 'cats9' | 'cats8' | 'points'; weights: Record<string, number> | null };
  teams: { name: string; mine: boolean; players: { name: string; team: string; position: string }[] }[];
}

/** One league from `league/<key>;out=settings` and `league/<key>/teams/roster`. */
export function parseLeague(settingsBody: unknown, rostersBody: unknown): YahooLeague {
  const meta = (findAll(simplify(settingsBody), 'league')[0] ?? {}) as Record<string, unknown>;
  const settings = (findAll(meta, 'settings')[0] ?? {}) as Record<string, unknown>;
  const stats = findAll(settings['stat_categories'], 'stat') as Record<string, unknown>[];
  const enabled = stats.filter((s) => str(s['enabled']) !== '0' && str(s['is_only_display_stat']) !== '1').map((s) => str(s['stat_id']));
  const modifiers = findAll(settings['stat_modifiers'], 'stat') as Record<string, unknown>[];
  const pointsLeague = /point/.test(str(meta['scoring_type']) || str(settings['scoring_type']));
  const weights: Record<string, number> = Object.fromEntries(Object.values(POINT_STAT_IDS).map((k) => [k, 0]));
  for (const m of modifiers) {
    const k = POINT_STAT_IDS[str(m['stat_id'])];
    if (k) weights[k] = Number(m['value']) || 0;
  }
  const slots = findAll(settings['roster_positions'], 'roster_position') as Record<string, unknown>[];
  const rosterSpots = slots.filter((p) => !INJURED_SLOTS.has(str(p['position']))).reduce((s, p) => s + (Number(p['count']) || 0), 0);

  const teams = findAll(simplify(rostersBody), 'team').map((t) => {
    const team = t as Record<string, unknown>;
    const players = findAll(team, 'player').map((p) => {
      const player = p as Record<string, unknown>;
      const name = player['name'] as Record<string, unknown> | undefined;
      return { name: str(name?.['full']), team: str(player['editorial_team_abbr']).toUpperCase(), position: str(player['display_position']) };
    });
    return { name: str(team['name']), mine: str(team['is_owned_by_current_login']) === '1', players: players.filter((p) => p.name) };
  });

  return {
    key: str(meta['league_key']),
    name: str(meta['name']),
    season: str(meta['season']),
    settings: {
      teams: Number(meta['num_teams']) || teams.length,
      rosterSpots,
      scoring: pointsLeague ? 'points' : enabled.includes(TURNOVERS) || enabled.length === 0 ? 'cats9' : 'cats8',
      weights: pointsLeague ? weights : null,
    },
    teams,
  };
}

type Credentials = Required<Pick<YahooEnv, 'YAHOO_CLIENT_ID' | 'YAHOO_CLIENT_SECRET'>>;
const configured = (env: YahooEnv): env is YahooEnv & Credentials => !!env.YAHOO_CLIENT_ID && !!env.YAHOO_CLIENT_SECRET;

/** Handles /auth/yahoo/* and /api/yahoo/*; anything else returns null. */
export async function handleYahoo(request: Request, env: YahooEnv, fetcher: Fetcher = fetch): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith('/auth/yahoo/') && !path.startsWith('/api/yahoo/')) return null;
  if (!configured(env) || env.YAHOO_IMPORT !== 'on') {
    return path === '/api/yahoo/status'
      ? json(200, { configured: configured(env), live: false, connected: false })
      : json(404, { error: 'The Yahoo import is not available yet' });
  }
  const redirectUri = `${url.origin}/auth/yahoo/callback`;

  if (path === '/auth/yahoo/start') {
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const auth = new URL(AUTH_URL);
    auth.search = new URLSearchParams({ client_id: env.YAHOO_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', state }).toString();
    return redirect(auth.toString(), [cookie(STATE_COOKIE, state, 600)]);
  }

  if (path === '/auth/yahoo/callback') {
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const expected = readCookie(request, STATE_COOKIE);
    if (!code || !state || !expected || state !== expected) return json(400, { error: 'The Yahoo sign-in could not be verified; start again from the League page.' });
    try {
      const tokens = await tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri }, fetcher);
      const sealed = await sealTokens(tokens, env.YAHOO_CLIENT_SECRET);
      return redirect(`${RETURN_PATH}&yahoo=connected`, [cookie(TOKEN_COOKIE, sealed, 60 * 60 * 24 * 30), cookie(STATE_COOKIE, '', 0)]);
    } catch {
      return redirect(`${RETURN_PATH}&yahoo=failed`, [cookie(STATE_COOKIE, '', 0)]);
    }
  }

  if (path === '/auth/yahoo/logout') return redirect(RETURN_PATH, [cookie(TOKEN_COOKIE, '', 0)]);

  let tokens = await openTokens(readCookie(request, TOKEN_COOKIE), env.YAHOO_CLIENT_SECRET);
  if (path === '/api/yahoo/status') return json(200, { configured: true, live: true, connected: !!tokens });
  if (!tokens) return json(401, { error: 'Not signed in to Yahoo' });

  // A fresh access token when the one in the cookie is missing or about to expire.
  const setCookies: string[] = [];
  if (!tokens.access || !tokens.expires || tokens.expires < Date.now()) {
    try {
      tokens = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: tokens.refresh, redirect_uri: redirectUri }, fetcher);
      setCookies.push(cookie(TOKEN_COOKIE, await sealTokens(tokens, env.YAHOO_CLIENT_SECRET), 60 * 60 * 24 * 30));
    } catch {
      return json(401, { error: 'The Yahoo sign-in has expired' }, { 'set-cookie': cookie(TOKEN_COOKIE, '', 0) });
    }
  }
  const get = async (resource: string, what: string) => {
    const res = await fetcher(`${API}/${resource}${resource.includes('?') ? '&' : '?'}format=json`, {
      headers: { authorization: `Bearer ${tokens.access}`, accept: 'application/json', 'user-agent': USER_AGENT },
    });
    if (!res.ok) {
      const detail = await yahooError(res);
      // Logged without the token: the status, the resource and Yahoo's explanation.
      console.error(`yahoo ${resource}: ${res.status} ${detail}`);
      throw Object.assign(new Error(`Yahoo returned ${res.status} for ${what}: ${detail}`), { status: res.status });
    }
    return res.json();
  };
  const respond = (status: number, body: unknown) => {
    const res = json(status, body);
    for (const c of setCookies) res.headers.append('set-cookie', c);
    return res;
  };

  try {
    if (path === '/api/yahoo/leagues') {
      return respond(200, parseLeagues(await get('users;use_login=1/games;game_codes=nba/leagues', 'your leagues')));
    }
    const match = /^\/api\/yahoo\/league\/(\d+\.l\.\d+)$/.exec(path);
    if (match) {
      const key = match[1]!;
      const [settings, rosters] = await Promise.all([get(`league/${key};out=settings`, 'the league settings'), get(`league/${key}/teams/roster`, 'the rosters')]);
      return respond(200, parseLeague(settings, rosters));
    }
  } catch (e) {
    const status = (e as { status?: number }).status;
    return respond(status === 401 ? 401 : 502, { error: e instanceof Error ? e.message : 'Yahoo request failed' });
  }
  return json(404, { error: 'Not Found' });
}
