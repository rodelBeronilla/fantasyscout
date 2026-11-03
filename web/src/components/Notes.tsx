/**
 * The scouting notes (phase 7; SPEC.md, "AI usage"; ADR 0017): the week's AI-drafted notes for
 * the league, each with the numbers it states traced to the board's history, and the eval. The
 * notes are published by the notes workflow to notes/<league>.json and notes/evals.json; no
 * number in them comes from the model.
 */
import { useEffect, useState } from 'react';

import { dataHref, type League } from '../lib/data';
import { fmt } from '../lib/format';
import { currentLeague, LEAGUE_LABEL } from '../lib/league';
import { href } from '../lib/site';
import { Card, Loading } from './ui';

interface Claim {
  metric: string;
  value: number;
  row_ref: string;
}

interface Note {
  player_id: string;
  name: string;
  team: string;
  reason: 'riser' | 'faller' | 'availability' | 'minutes';
  headline: string;
  body: string;
  confidence: 'low' | 'medium' | 'high';
  claims: Claim[];
}

interface NotesFile {
  league: League;
  label: string;
  model: string | null;
  generated_at: string | null;
  compared: { before: string | null; after: string | null };
  counts: { drafted: number; published: number; rejected: number; numbers_written: number; numbers_traced: number };
  notes: Note[];
  rejected: { player_id: string; name: string; reasons: string[] }[];
}

interface Evals {
  model: string | null;
  generated_at: string;
  leagues: Record<string, { weeks: unknown[]; drafted: number; rejection_rate: number | null; claim_accuracy: number | null; published_claims_verified: number | null }>;
}

/** The metric names the notes' claims use, in words. */
const METRIC: Record<string, string> = {
  value_rest_of_season: 'rest-of-season value',
  rank: 'board rank',
  projected_minutes: 'projected minutes',
  projected_points: 'projected points',
  projected_rebounds: 'projected rebounds',
  projected_assists: 'projected assists',
  availability_share: 'share of games',
  games_remaining: 'games left',
};
const REASON: Record<Note['reason'], string> = { riser: 'Riser', faller: 'Faller', availability: 'Availability', minutes: 'Minutes' };

const claimText = (c: Claim) => {
  const [metric = '', part = ''] = c.metric.split('.');
  return `${METRIC[metric] ?? metric} ${part === 'change' ? 'change' : part}: ${fmt(c.value)}`;
};

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(dataHref(path));
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export default function Notes() {
  const [league] = useState<League>(() => currentLeague());
  const [file, setFile] = useState<NotesFile | null | undefined>(undefined);
  const [evals, setEvals] = useState<Evals | null>(null);
  useEffect(() => {
    void getJson<NotesFile>(`notes/${league}.json`).then(setFile);
    void getJson<Evals>('notes/evals.json').then(setEvals);
  }, [league]);
  if (file === undefined) return <Loading what="the notes" />;
  const evalFor = evals?.leagues[league];
  return (
    <div className="grid gap-4">
      {!file ? (
        <p className="text-sm text-muted" data-testid="notes-none">
          No {LEAGUE_LABEL[league]} notes yet: they are drafted every Monday from the week&apos;s board history.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted" data-testid="notes-meta">
            {file.label}: drafted by {file.model ?? 'the local model'} on {file.generated_at?.slice(0, 10) ?? 'an unknown day'}, comparing the board on{' '}
            {file.compared.before} with {file.compared.after}. {file.counts.published} of {file.counts.drafted} drafts passed the validator, which traces
            every number a note states to the board&apos;s history and rejects the note when one is not there.
          </p>
          <ul className="grid gap-3 md:grid-cols-2" data-testid="notes">
            {file.notes.map((n) => (
              <li key={n.player_id} className="rounded-lg border border-line bg-card p-3" data-testid="note">
                <p className="text-xs text-muted">
                  <span className="font-semibold uppercase">{REASON[n.reason]}</span> ·{' '}
                  <a href={href(`/p/${league}/${n.player_id}/`)} className="underline-offset-4 hover:underline">
                    {n.name}
                  </a>{' '}
                  · {n.team || 'FA'} · {n.confidence} confidence
                </p>
                <h2 className="mt-1 font-semibold">{n.headline}</h2>
                <p className="mt-1 text-sm">{n.body}</p>
                <details className="mt-2 text-xs text-muted">
                  <summary className="cursor-pointer">The numbers, from the board&apos;s history</summary>
                  <ul className="mt-1 grid gap-0.5" data-testid="note-claims">
                    {n.claims.map((c) => (
                      <li key={c.metric}>
                        {claimText(c)} <span className="font-mono">({c.row_ref})</span>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
          {file.rejected.length > 0 && (
            <Card title="Rejected by the validator" id="rejected">
              <ul className="grid gap-1 text-sm" data-testid="notes-rejected">
                {file.rejected.map((r) => (
                  <li key={r.player_id}>
                    <strong>{r.name}</strong>: <span className="text-muted">{r.reasons.join('; ')}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
      <Card title="How the notes are kept honest" id="eval">
        <div className="grid gap-2 text-sm">
          <p>
            No number on this site comes from a language model. The pipeline picks the players and their numbers; a local model (running on the
            project&apos;s own server) writes the words; a validator then finds each number in the note among the player&apos;s numbers and drops the
            note if one is not there, or if the words say a number went the wrong way.
          </p>
          {evalFor ? (
            <p data-testid="notes-eval">
              Eval over {evalFor.weeks.length} earlier snapshot{evalFor.weeks.length === 1 ? '' : 's'} ({evalFor.drafted} drafts, {evals?.model}): of every
              number the drafts wrote, {evalFor.claim_accuracy === null ? '–' : `${Math.round(evalFor.claim_accuracy * 100)}%`} were the build&apos;s;{' '}
              {evalFor.rejection_rate === null ? '–' : `${Math.round(evalFor.rejection_rate * 100)}%`} of drafts were rejected; 100% of the numbers in
              published notes are verified.
            </p>
          ) : (
            <p className="text-muted">The eval runs with the notes and appears here once it has.</p>
          )}
        </div>
      </Card>
    </div>
  );
}
