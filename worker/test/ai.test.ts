// The live AI route (ai.ts) against a stand-in for the model behind the tunnel: signed-in only,
// the Access service token sent, and an answer with a number the trade does not hold refused.
import { describe, expect, it } from 'vitest';
import { accountCookie } from '../src/account';
import { factNumbers, handleAi, strayNumbers } from '../src/ai';

const ORIGIN = 'https://fantasyscout.example';
const BASE = { YAHOO_CLIENT_ID: 'id', YAHOO_CLIENT_SECRET: 'secret', DATA: {} as R2Bucket };
const ON = { ...BASE, AI_URL: 'https://ai.example', AI_ACCESS_CLIENT_ID: 'cid', AI_ACCESS_CLIENT_SECRET: 'csecret' };
const FACTS = { give: ['A'], get: ['B'], categories: { before: 5.11, after: 5.31, change: 0.2 }, value: { lean: 'you +4%' } };

const cookie = async () => (await accountCookie('secret', 'SOMEONE')).split(';')[0]!;
const explain = async (headers: Record<string, string>, body: unknown = { facts: FACTS }) =>
  new Request(`${ORIGIN}/api/ai/explain-trade`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const model = (answers: string[], seen: RequestInit[] = []) => {
  let i = 0;
  return (async (_url: string, init?: RequestInit) => {
    seen.push(init ?? {});
    const explanation = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return Response.json({ message: { content: JSON.stringify({ explanation }) } });
  }) as unknown as typeof fetch;
};

describe('the live AI', () => {
  it('says whether it is set up and whether the browser is signed in', async () => {
    const status = async (env: typeof BASE, headers: Record<string, string> = {}) =>
      (await handleAi(new Request(`${ORIGIN}/api/ai/status`, { headers }), env))!.json();
    expect(await status(BASE)).toEqual({ available: false, signedIn: false });
    expect(await status(ON, { cookie: await cookie() })).toEqual({ available: true, signedIn: true });
  });

  it('explains a trade for a signed-in manager, passing the service token, when every number is the trade’s', async () => {
    const seen: RequestInit[] = [];
    const res = (await handleAi(await explain({ cookie: await cookie() }), ON, model(['Take it: you go from 5.11 to 5.31 categories a week, up 0.2.'], seen)))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ explanation: 'Take it: you go from 5.11 to 5.31 categories a week, up 0.2.' });
    const headers = new Headers(seen[0]!.headers);
    expect(headers.get('CF-Access-Client-Id')).toBe('cid');
    expect(headers.get('CF-Access-Client-Secret')).toBe('csecret');
  });

  it('retries once and refuses an answer that keeps writing a number the trade does not hold', async () => {
    const ok = (await handleAi(await explain({ cookie: await cookie() }), ON, model(['You win 7 more.', 'You go to 5.31.'])))!;
    expect(ok.status).toBe(200);
    const bad = (await handleAi(await explain({ cookie: await cookie() }), ON, model(['You win 7 more.'])))!;
    expect(bad.status).toBe(422);
  });

  it('is closed to a visitor who is not signed in, to another site, and until it is set up', async () => {
    expect((await handleAi(await explain({}), ON, model(['x'])))!.status).toBe(401);
    expect((await handleAi(await explain({ cookie: await cookie(), origin: 'https://evil.example' }), ON, model(['x'])))!.status).toBe(403);
    expect((await handleAi(await explain({ cookie: await cookie() }), BASE, model(['x'])))!.status).toBe(503);
    const down = (async () => new Response('busy', { status: 502 })) as unknown as typeof fetch;
    expect((await handleAi(await explain({ cookie: await cookie() }), ON, down))!.status).toBe(502);
  });

  it('collects the facts’ numbers and finds the stray ones at the precision written', () => {
    const numbers = factNumbers(FACTS);
    expect(numbers).toEqual(expect.arrayContaining([5.11, 5.31, 0.2, 4]));
    expect(strayNumbers('From 5.11 to 5.31, you +4%.', numbers)).toEqual([]);
    expect(strayNumbers('You gain 0.25 and 7 more.', numbers)).toEqual(['0.25', '7']);
  });
});
