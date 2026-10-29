// The Yahoo league import, against a stand-in for Yahoo: the sign-in round trip, the sealed
// token cookie, refreshing, and turning Yahoo's JSON into the League page's shape.
import { describe, expect, it } from 'vitest';
import { handleYahoo, openTokens, parseLeague, parseLeagues, readCookie, sealTokens, simplify } from '../src/yahoo';

const ORIGIN = 'https://fantasyscout.example';
const ENV = { YAHOO_CLIENT_ID: 'client-id', YAHOO_CLIENT_SECRET: 'client-secret', YAHOO_IMPORT: 'on' };

// Shapes as Yahoo's Fantasy API returns them with format=json.
const LEAGUES = {
  fantasy_content: {
    users: {
      '0': {
        user: [
          { guid: 'ABC' },
          {
            games: {
              '0': {
                game: [
                  { game_key: '466', code: 'nba', season: '2025' },
                  {
                    leagues: {
                      '0': { league: [{ league_key: '466.l.1234', name: 'Hoops Club', num_teams: 12, season: '2025' }] },
                      '1': { league: [{ league_key: '466.l.99', name: 'Work League', num_teams: 10, season: '2025' }] },
                      count: 2,
                    },
                  },
                ],
              },
              count: 1,
            },
          },
        ],
      },
      count: 1,
    },
  },
};

const cat = (id: number, extra: Record<string, string> = {}) => ({ stat: { stat_id: id, enabled: '1', ...extra } });
const slot = (position: string, count: number) => ({ roster_position: { position, count } });

const SETTINGS = {
  fantasy_content: {
    league: [
      { league_key: '466.l.1234', name: 'Hoops Club', num_teams: 12, scoring_type: 'head', season: '2025' },
      {
        settings: [
          {
            roster_positions: [slot('PG', 1), slot('SG', 1), slot('G', 1), slot('SF', 1), slot('PF', 1), slot('F', 1), slot('C', 2), slot('Util', 2), slot('BN', 3), slot('IL', 2)],
            stat_categories: { stats: [cat(9004003, { is_only_display_stat: '1' }), cat(5), cat(8), cat(10), cat(12), cat(15), cat(16), cat(17), cat(18), cat(19)] },
          },
        ],
      },
    ],
  },
};

const player = (name: string, team: string, position: string) => ({
  player: [
    [{ player_key: `466.p.${name.length}` }, { name: { full: name, first: name.split(' ')[0] } }, { editorial_team_abbr: team }, { display_position: position }],
    { selected_position: [{ coverage_type: 'date' }, { position: position.split(',')[0] }] },
  ],
});

const ROSTERS = {
  fantasy_content: {
    league: [
      { league_key: '466.l.1234', name: 'Hoops Club' },
      {
        teams: {
          '0': {
            team: [
              [{ team_key: '466.l.1234.t.1' }, { name: 'Dunk Tank' }, [], { is_owned_by_current_login: 1 }, { managers: [{ manager: { nickname: 'me' } }] }],
              { roster: { coverage_type: 'date', '0': { players: { '0': player('Nikola Jokić', 'Den', 'C'), '1': player('Stephen Curry', 'GS', 'PG'), count: 2 } } } },
            ],
          },
          '1': {
            team: [[{ team_key: '466.l.1234.t.2' }, { name: 'Brick City' }], { roster: { '0': { players: { '0': player('LeBron James', 'LAL', 'SF,PF'), count: 1 } } } }],
          },
          count: 2,
        },
      },
    ],
  },
};

/** A stand-in for Yahoo that records what it was asked. */
function fakeYahoo() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('/oauth2/get_token')) return Response.json({ access_token: `access-${calls.length}`, refresh_token: 'refresh-1', expires_in: 3600 });
    if (url.includes('/leagues')) return Response.json(LEAGUES);
    if (url.includes(';out=settings')) return Response.json(SETTINGS);
    if (url.includes('/teams/roster')) return Response.json(ROSTERS);
    return new Response('not found', { status: 404 });
  };
  return { calls, fetcher };
}

const get = (path: string, cookie?: string) => new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
const setCookie = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0]
    ?.slice(name.length + 1) ?? null;

describe('reading Yahoo JSON', () => {
  it('turns numbered lists into arrays and merges resource fragments', () => {
    expect(simplify({ '0': { a: 1 }, '1': { a: 2 }, count: 2 })).toEqual([{ a: 1 }, { a: 2 }]);
    expect(simplify([[{ k: 1 }, { name: 'x' }], { sub: 2 }])).toEqual({ k: 1, name: 'x', sub: 2 });
    expect(simplify([{ stat: { id: 1 } }, { stat: { id: 2 } }])).toEqual([{ stat: { id: 1 } }, { stat: { id: 2 } }]);
  });

  it('lists the manager’s leagues', () => {
    expect(parseLeagues(LEAGUES)).toEqual([
      { key: '466.l.1234', name: 'Hoops Club', season: '2025', teams: 12 },
      { key: '466.l.99', name: 'Work League', season: '2025', teams: 10 },
    ]);
  });

  it('reads a category league: size, roster spots without injured slots, 9-cat, and every roster', () => {
    const league = parseLeague(SETTINGS, ROSTERS);
    expect(league.settings).toEqual({ teams: 12, rosterSpots: 13, scoring: 'cats9', weights: null });
    expect(league.teams).toEqual([
      {
        name: 'Dunk Tank',
        mine: true,
        players: [
          { name: 'Nikola Jokić', team: 'DEN', position: 'C' },
          { name: 'Stephen Curry', team: 'GS', position: 'PG' },
        ],
      },
      { name: 'Brick City', mine: false, players: [{ name: 'LeBron James', team: 'LAL', position: 'SF,PF' }] },
    ]);
  });

  it('reads an 8-cat league and a points league', () => {
    const eight = structuredClone(SETTINGS);
    const stats = (eight.fantasy_content.league[1] as { settings: { stat_categories: { stats: unknown[] } }[] }).settings[0]!.stat_categories.stats;
    stats.pop();
    expect(parseLeague(eight, ROSTERS).settings.scoring).toBe('cats8');

    const points = structuredClone(SETTINGS) as unknown as { fantasy_content: { league: Record<string, unknown>[] } };
    points.fantasy_content.league[0]!['scoring_type'] = 'headpoint';
    (points.fantasy_content.league[1]!['settings'] as Record<string, unknown>[])[0]!['stat_modifiers'] = {
      stats: [{ stat: { stat_id: '12', value: '1' } }, { stat: { stat_id: '17', value: '3' } }, { stat: { stat_id: '19', value: '-1' } }],
    };
    const settings = parseLeague(points, ROSTERS).settings;
    expect(settings.scoring).toBe('points');
    expect(settings.weights).toMatchObject({ points: 1, steals: 3, turnovers: -1, rebounds: 0 });
  });
});

describe('the token cookie', () => {
  it('opens what it sealed, and nothing sealed under another secret or tampered with', async () => {
    const sealed = await sealTokens({ refresh: 'r', access: 'a', expires: 5 }, 'secret');
    expect(await openTokens(sealed, 'secret')).toEqual({ refresh: 'r', access: 'a', expires: 5 });
    expect(await openTokens(sealed, 'other')).toBeNull();
    expect(await openTokens(`${sealed.slice(0, -2)}AA`, 'secret')).toBeNull();
    expect(await openTokens(null, 'secret')).toBeNull();
  });

  it('leaves a very long access token out rather than overflow the cookie', async () => {
    const sealed = await sealTokens({ refresh: 'r', access: 'x'.repeat(5000), expires: 5 }, 'secret');
    expect(sealed.length).toBeLessThan(3800);
    expect(await openTokens(sealed, 'secret')).toEqual({ refresh: 'r' });
  });
});

describe('the sign-in and the league routes', () => {
  it('reports that it is not configured until the secrets are set', async () => {
    const status = await handleYahoo(get('/api/yahoo/status'), {});
    expect(await status?.json()).toEqual({ configured: false, live: false, connected: false });
    expect((await handleYahoo(get('/auth/yahoo/start'), {}))?.status).toBe(404);
    expect(await handleYahoo(get('/league/'), ENV)).toBeNull();
  });

  it('stays closed with the secrets set until YAHOO_IMPORT is on', async () => {
    const parked = { YAHOO_CLIENT_ID: 'client-id', YAHOO_CLIENT_SECRET: 'client-secret' };
    const status = await handleYahoo(get('/api/yahoo/status'), parked);
    expect(await status?.json()).toEqual({ configured: true, live: false, connected: false });
    for (const path of ['/auth/yahoo/start', '/auth/yahoo/callback?code=c&state=s', '/api/yahoo/leagues']) {
      expect((await handleYahoo(get(path), { ...parked, YAHOO_IMPORT: 'off' }))?.status).toBe(404);
    }
  });

  it('signs in with a checked state, keeps the tokens sealed in a cookie, and reads a league', async () => {
    const { calls, fetcher } = fakeYahoo();
    const start = (await handleYahoo(get('/auth/yahoo/start'), ENV, fetcher))!;
    expect(start.status).toBe(302);
    const auth = new URL(start.headers.get('location')!);
    expect(auth.origin + auth.pathname).toBe('https://api.login.yahoo.com/oauth2/request_auth');
    expect(auth.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/yahoo/callback`);
    const state = setCookie(start, 'fs_yahoo_state')!;
    expect(auth.searchParams.get('state')).toBe(state);

    const forged = await handleYahoo(get(`/auth/yahoo/callback?code=c&state=other`, `fs_yahoo_state=${state}`), ENV, fetcher);
    expect(forged!.status).toBe(400);
    expect(calls).toHaveLength(0);

    const back = (await handleYahoo(get(`/auth/yahoo/callback?code=c&state=${state}`, `fs_yahoo_state=${state}`), ENV, fetcher))!;
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/league/?league=nba&yahoo=connected');
    expect(String(calls[0]!.init?.body)).toContain('grant_type=authorization_code');
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe(`Basic ${btoa('client-id:client-secret')}`);
    const sealed = setCookie(back, 'fs_yahoo')!;
    expect(sealed).not.toContain('access');
    expect(back.headers.getSetCookie().find((c) => c.startsWith('fs_yahoo='))).toMatch(/HttpOnly; Secure; SameSite=Lax/);

    const status = await handleYahoo(get('/api/yahoo/status', `fs_yahoo=${sealed}`), ENV, fetcher);
    expect(await status!.json()).toEqual({ configured: true, live: true, connected: true });
    const leagues = await handleYahoo(get('/api/yahoo/leagues', `fs_yahoo=${sealed}`), ENV, fetcher);
    expect(await leagues!.json()).toHaveLength(2);
    const league = await handleYahoo(get('/api/yahoo/league/466.l.1234', `fs_yahoo=${sealed}`), ENV, fetcher);
    expect(league!.status).toBe(200);
    expect(((await league!.json()) as { teams: unknown[] }).teams).toHaveLength(2);
    expect(new Headers(calls.at(-1)!.init?.headers).get('authorization')).toBe('Bearer access-1');
  });

  it('refreshes an expired access token and sends the new cookie back', async () => {
    const { calls, fetcher } = fakeYahoo();
    const sealed = await sealTokens({ refresh: 'refresh-0', access: 'old', expires: Date.now() - 1 }, ENV.YAHOO_CLIENT_SECRET);
    const res = (await handleYahoo(get('/api/yahoo/leagues', `fs_yahoo=${sealed}`), ENV, fetcher))!;
    expect(res.status).toBe(200);
    expect(String(calls[0]!.init?.body)).toContain('grant_type=refresh_token');
    expect(String(calls[0]!.init?.body)).toContain('refresh_token=refresh-0');
    const fresh = await openTokens(setCookie(res, 'fs_yahoo'), ENV.YAHOO_CLIENT_SECRET);
    expect(fresh?.access).toBe('access-1');
  });

  it('asks for a sign-in without a cookie, with a forged one, and for a malformed league key', async () => {
    const { fetcher } = fakeYahoo();
    expect((await handleYahoo(get('/api/yahoo/leagues'), ENV, fetcher))!.status).toBe(401);
    expect((await handleYahoo(get('/api/yahoo/leagues', 'fs_yahoo=forged'), ENV, fetcher))!.status).toBe(401);
    const sealed = await sealTokens({ refresh: 'r', access: 'a', expires: Date.now() + 60_000 }, ENV.YAHOO_CLIENT_SECRET);
    expect((await handleYahoo(get('/api/yahoo/league/not-a-key', `fs_yahoo=${sealed}`), ENV, fetcher))!.status).toBe(404);
    const out = (await handleYahoo(get('/auth/yahoo/logout', `fs_yahoo=${sealed}`), ENV, fetcher))!;
    expect(out.headers.getSetCookie().find((c) => c.startsWith('fs_yahoo='))).toContain('Max-Age=0');
  });

  it('reads a cookie by name', () => {
    expect(readCookie(get('/', 'a=1; fs_yahoo=x=y; b=2'), 'fs_yahoo')).toBe('x=y');
    expect(readCookie(get('/'), 'fs_yahoo')).toBeNull();
  });
});

describe('when Yahoo refuses', () => {
  const signedIn = () => sealTokens({ refresh: 'r', access: 'a', expires: Date.now() + 60_000 }, ENV.YAHOO_CLIENT_SECRET);

  it('passes Yahoo’s own explanation through, naming the request that failed', async () => {
    const fetcher = async () => Response.json({ error: { lang: 'en-US', description: 'You are not allowed to view this page because it is private.' } }, { status: 403 });
    const res = (await handleYahoo(get('/api/yahoo/leagues', `fs_yahoo=${await signedIn()}`), ENV, fetcher))!;
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Yahoo returned 403 for your leagues: You are not allowed to view this page because it is private.' });
  });

  it('reads the text of an HTML error page and keeps it short', async () => {
    const page = `<html><head><style>p{}</style></head><body><h1>Request denied</h1><p>${'x'.repeat(600)}</p></body></html>`;
    const fetcher = async () => new Response(page, { status: 403, statusText: 'Forbidden' });
    const res = (await handleYahoo(get('/api/yahoo/league/466.l.1234', `fs_yahoo=${await signedIn()}`), ENV, fetcher))!;
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/^Yahoo returned 403 for the (league settings|rosters): Request denied x+$/);
    expect(error.length).toBeLessThan(400);
  });

  it('sends a User-Agent on every Yahoo request', async () => {
    const { calls, fetcher } = fakeYahoo();
    const expired = await sealTokens({ refresh: 'r', access: 'old', expires: Date.now() - 1 }, ENV.YAHOO_CLIENT_SECRET);
    await handleYahoo(get('/api/yahoo/league/466.l.1234', `fs_yahoo=${expired}`), ENV, fetcher);
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(new Headers(call.init?.headers).get('user-agent')).toMatch(/^FantasyScout\//);
  });
});
