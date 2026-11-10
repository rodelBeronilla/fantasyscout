/**
 * "Explain this trade" (phase 7, ADR 0017): the local model puts the scorecard's numbers into a
 * few plain sentences. It writes words only; the Worker refuses an answer with a number the trade
 * does not hold (worker/src/ai.ts). Shown only where the AI is set up, and to signed-in managers.
 */
import { useEffect, useState } from 'react';

import { href } from '../lib/site';

interface Status {
  available: boolean;
  signedIn: boolean;
}

export default function ExplainTrade({ facts }: { facts: Record<string, unknown> }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [state, setState] = useState<{ loading?: boolean; text?: string; error?: string }>({});
  const key = JSON.stringify(facts);
  useEffect(() => {
    let live = true;
    fetch('/api/ai/status', { credentials: 'same-origin' })
      .then(async (r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? ((await r.json()) as Status) : null))
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, []);
  // a new trade clears the last explanation
  useEffect(() => setState({}), [key]);
  if (!status?.available) return null;
  if (!status.signedIn) {
    return (
      <p className="text-sm text-muted" data-testid="explain-signin">
        <a href={href('/league/')} className="underline underline-offset-4">
          Sign in with Yahoo
        </a>{' '}
        to have the AI explain this trade in plain words.
      </p>
    );
  }
  const ask = async () => {
    setState({ loading: true });
    try {
      const r = await fetch('/api/ai/explain-trade', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ facts }),
      });
      const body = (await r.json()) as { explanation?: string; error?: string };
      setState(body.explanation ? { text: body.explanation } : { error: body.error ?? 'The AI did not answer.' });
    } catch {
      setState({ error: 'The AI did not answer. Try again later.' });
    }
  };
  return (
    <div className="grid gap-2 rounded-lg border border-line bg-bg p-3" data-testid="explain-trade">
      {!state.text && (
        <button
          type="button"
          onClick={() => void ask()}
          disabled={state.loading}
          className="justify-self-start rounded-full border border-accent px-4 py-1.5 text-sm font-semibold text-accent hover:bg-accent hover:text-accent-fg disabled:opacity-60"
        >
          {state.loading ? 'Explaining…' : 'Explain this trade'}
        </button>
      )}
      {state.text && (
        <>
          <p className="text-sm" data-testid="explain-text">
            {state.text}
          </p>
          <p className="text-xs text-muted">AI-drafted from the numbers above; every number in it was checked against them.</p>
        </>
      )}
      {state.error && (
        <p className="text-sm text-bad" role="status">
          {state.error}
        </p>
      )}
    </div>
  );
}
