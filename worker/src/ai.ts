/**
 * Live AI on the site (phase 7, ADR 0017): "explain this trade" in plain words, drafted by the
 * local model on the home server and reached through a Cloudflare Tunnel that only this Worker
 * can pass (an Access service token). Signed-in managers only (#684), a few requests a minute
 * each. The rule of the notes holds: no number comes from the model. The page sends the trade's
 * numbers, the model writes words about them, and an answer with any number the page did not
 * send is refused.
 *
 *   GET  /api/ai/status          -> { available, signedIn }
 *   POST /api/ai/explain-trade   -> { explanation } from { facts }
 *
 * Closed (available: false) until AI_URL, AI_ACCESS_CLIENT_ID and AI_ACCESS_CLIENT_SECRET are set.
 */
import { accountOfRequest, type AccountEnv } from './account';

export interface AiEnv extends AccountEnv {
  /** The tunnel's public address of the model (Ollama), e.g. https://ai.example.com */
  AI_URL?: string;
  AI_ACCESS_CLIENT_ID?: string;
  AI_ACCESS_CLIENT_SECRET?: string;
  /** The model's name; qwen3:8b by default. */
  AI_MODEL?: string;
  /** Per-account rate limit (wrangler.toml, ratelimits). */
  AI_LIMIT?: RateLimit;
}

const MAX_FACTS = 8 * 1024;
const MAX_WORDS = 90;
const SYSTEM = [
  'You explain a fantasy basketball trade to the manager who is weighing it, in plain words, from the facts you are given and nothing else.',
  'The facts are JSON: what the manager gives and gets, the partner, the verdict, and the numbers behind it (expected categories won a week before and after for each team, the categories that rise and fall, projected value and the market as a lean in percent, and notes on form and injuries).',
  'Rules: use only numbers that appear in the facts, written exactly as given; do not compute or invent any number. At most 90 words, three or four sentences: whether to make the trade and why, what it does to each team, and the main risk. Address the manager as "you". Do not mention the facts, JSON, a model or these rules.',
].join('\n');

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' } });
}

const available = (env: AiEnv) => !!(env.AI_URL && env.AI_ACCESS_CLIENT_ID && env.AI_ACCESS_CLIENT_SECRET);

/** Every number in a JSON value, with the decimals it is written with. */
export function factNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  else if (typeof value === 'string') for (const m of value.matchAll(NUMBER)) out.push(Number(m[0].replace(/%/g, '').replace(/−/g, '-')));
  else if (Array.isArray(value)) for (const v of value) factNumbers(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) factNumbers(v, out);
  return out;
}

const NUMBER = /(?<![\w.])[-+−]?\d+(?:\.\d+)?%?/g;

/** The numbers written in the text that are none of the facts' (at the precision written, signs aside). */
export function strayNumbers(text: string, facts: number[]): string[] {
  const stray: string[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const token = m[0];
    const written = Number(token.replace(/%/g, '').replace(/−/g, '-'));
    const decimals = token.replace(/%/g, '').split('.')[1]?.length ?? 0;
    const tol = 0.5 * 10 ** -decimals + 1e-9;
    if (!facts.some((f) => Math.abs(Math.abs(written) - Math.abs(f)) <= tol)) stray.push(token);
  }
  return stray;
}

async function draft(env: AiEnv, facts: unknown, fetcher: typeof fetch): Promise<string> {
  const res = await fetcher(`${env.AI_URL!.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'CF-Access-Client-Id': env.AI_ACCESS_CLIENT_ID!,
      'CF-Access-Client-Secret': env.AI_ACCESS_CLIENT_SECRET!,
    },
    body: JSON.stringify({
      model: env.AI_MODEL || 'qwen3:8b',
      stream: false,
      think: false,
      options: { temperature: 0.2 },
      format: { type: 'object', properties: { explanation: { type: 'string' } }, required: ['explanation'] },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: JSON.stringify(facts) },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`model ${res.status}`);
  const body = (await res.json()) as { message?: { content?: string } };
  const parsed = JSON.parse(body.message?.content ?? '{}') as { explanation?: unknown };
  if (typeof parsed.explanation !== 'string' || !parsed.explanation.trim()) throw new Error('no explanation');
  return parsed.explanation.trim();
}

/** Handles the AI routes; anything else returns null. */
export async function handleAi(request: Request, env: AiEnv, fetcher: typeof fetch = fetch): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/ai/')) return null;
  const account = await accountOfRequest(request, env);
  if (url.pathname === '/api/ai/status') return json(200, { available: available(env), signedIn: !!account });
  if (url.pathname !== '/api/ai/explain-trade') return json(404, { error: 'not found' });
  if (request.method !== 'POST') return json(405, { error: 'POST only' });
  if (!available(env)) return json(503, { error: 'The AI is not set up on this site.' });
  if (!account) return json(401, { error: 'Sign in with Yahoo to use the AI.' });
  if (request.headers.get('origin') !== url.origin) return json(403, { error: 'cross-site request' });
  if (env.AI_LIMIT && !(await env.AI_LIMIT.limit({ key: account })).success) {
    return json(429, { error: 'A few explanations a minute: try again shortly.' });
  }
  const text = await request.text();
  if (text.length > MAX_FACTS) return json(413, { error: 'too much to explain' });
  let body: { facts?: unknown };
  try {
    body = JSON.parse(text) as { facts?: unknown };
  } catch {
    return json(400, { error: 'not JSON' });
  }
  if (!body.facts || typeof body.facts !== 'object') return json(400, { error: 'expected { facts }' });
  const numbers = factNumbers(body.facts);
  // one retry: a small model sometimes rounds a number differently; a second miss is refused
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let explanation: string;
    try {
      explanation = await draft(env, body.facts, fetcher);
    } catch {
      return json(502, { error: 'The AI did not answer. The home server may be busy or down; try again later.' });
    }
    const words = explanation.split(/\s+/).length;
    if (words <= MAX_WORDS + 10 && strayNumbers(explanation, numbers).length === 0) return json(200, { explanation });
  }
  return json(422, { error: 'The AI wrote a number the trade does not hold, so its answer was dropped. Try again.' });
}
