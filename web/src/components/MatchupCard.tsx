/**
 * This week's matchup on My Team (#490): the categories the manager projects to win, lose or split
 * against one opponent. It leads with the call (#817): the count, the swing category, and the open
 * days to stream into. An ESPN category league starts from the score so far.
 */
import { CATEGORY_LABELS, CATEGORY_WORDS, fmt } from '../lib/format';
import type { League } from '../lib/data';
import type { LeagueSetup } from '../lib/fantasy-league';
import { isRatio, matchupCall, swingCategory, type WeekMatchup } from '../lib/matchup';
import { type StreamMove, streamTargets } from '../lib/matchup-streams';
import { pickupsPath } from '../lib/pickups-url';
import { href } from '../lib/site';
import { Signed, Td, Th, Unvalidated } from './ui';

/** Where the week's totals start: ESPN's score so far, or the projection alone and why. */
export type MatchupBasis = { live: true; projectedOnly: string[] } | { live: false; reason: 'not-espn' | 'no-score' | 'stale' };

const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const dayName = (iso: string) => DAY.format(new Date(`${iso}T12:00:00Z`));
const word = (cat: string) => CATEGORY_WORDS[cat] ?? CATEGORY_LABELS[cat] ?? cat;
const link = 'font-medium text-accent underline-offset-4 hover:underline';

/** Why the week projects from the games left alone, in a line; nothing when it starts from the score. */
function basisNote(basis: MatchupBasis | null): string | null {
  if (!basis) return null;
  if (basis.live) {
    if (!basis.projectedOnly.length) return null;
    const cats = basis.projectedOnly.map((c) => CATEGORY_LABELS[c] ?? c).join(' and ');
    return basis.projectedOnly.length === 1
      ? `${cats} projects from the games left only: ESPN gave the score so far without it, or without the shots behind it.`
      : `${cats} project from the games left only: ESPN gave the score so far without them, or without the shots behind them.`;
  }
  if (basis.reason === 'not-espn') return 'Import the league from ESPN to start from the live score.';
  if (basis.reason === 'stale') return 'The score so far waits on a sync with ESPN today; until then the week projects from the games left.';
  return 'ESPN has no score for this matchup yet, so the week projects from the games left.';
}

/** "Add Jones, drop Lee: flips steals, 2 games on your open days", with every stream one click down (#818). */
function StreamLine({ stream, league, nameOf, pickups }: { stream: StreamMove; league: League; nameOf: (id: string) => string; pickups: string }) {
  const player = (id: string) => (
    <a href={href(`/p/${league}/${id}/`)} className="font-medium underline-offset-4 hover:underline">
      {nameOf(id)}
    </a>
  );
  const words = (cats: string[]) => cats.map(word).join(' and ');
  const games = `${stream.games} ${stream.games === 1 ? 'game' : 'games'} on your open days`;
  return (
    <p className="mt-1 text-sm" data-testid="matchup-stream-move">
      Add {player(stream.add)}
      {stream.drop ? <>, drop {player(stream.drop)}</> : null}:{' '}
      {stream.flips.length ? (
        <strong data-testid="matchup-flips">flips {words(stream.flips)}</strong>
      ) : (
        <span>
          best for {words(stream.targets.slice(0, 2))}, short of flipping {stream.targets.length === 1 ? 'it' : 'one'} alone
        </span>
      )}
      , {games}.{' '}
      <a href={pickups} className="text-accent underline underline-offset-4" data-testid="matchup-streams-link">
        Every stream for them →
      </a>
    </p>
  );
}

export function Matchup({
  setup,
  match,
  basis,
  points,
  league,
  openDays,
  stream = null,
  nameOf = (id) => id,
  onOpponent,
}: {
  setup: LeagueSetup;
  match: WeekMatchup | null;
  basis: MatchupBasis | null;
  points: boolean;
  league: League;
  /** The days the manager's lineup has a slot open, to stream into. */
  openDays: string[];
  /** The best stream for the close and losing categories, with its drop (#818). */
  stream?: StreamMove | null;
  nameOf?: (id: string) => string;
  onOpponent: (team: number | null) => void;
}) {
  const them = setup.opponent === null ? null : (setup.names[setup.opponent] ?? `Team ${setup.opponent + 1}`);
  const show = (cat: string, v: number) => (isRatio(cat) ? `${fmt(v * 100, 1)}%` : fmt(v, 0));
  const tone = (r: WeekMatchup['cats'][number]['result']) => (r === 'win' ? 'text-good' : r === 'loss' ? 'text-bad' : 'text-muted');
  const swing = match && !points ? swingCategory(match) : null;
  const note = points ? null : basisNote(basis);
  const live = !!basis?.live;
  // Pickups for the open days, with the close and losing categories as need chips (#818)
  const pickups = href(pickupsPath(league, { week: true, open: openDays, need: match && !points ? streamTargets(match) : [] }));
  return (
    <section className="rounded-lg border border-line bg-card p-3" aria-labelledby="matchup-h" data-testid="matchup">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="matchup-h" className="text-sm font-medium tracking-wide text-muted uppercase">
          This week&apos;s matchup
          <Unvalidated issue={754} what="The weekly projection" />
        </h2>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Opponent</span>
          <select
            value={setup.opponent ?? ''}
            onChange={(e) => onOpponent(e.target.value === '' ? null : Number(e.target.value))}
            className="rounded border border-line bg-bg px-2 py-1 text-sm"
            aria-label="This week's opponent"
          >
            <option value="">Choose a team</option>
            {setup.names.map((name, t) =>
              t === setup.mine ? null : (
                <option key={t} value={t}>
                  {name}
                </option>
              ),
            )}
          </select>
        </label>
      </div>
      {!match || them === null ? (
        <p className="mt-1 text-sm text-muted" data-testid="matchup-summary">
          Pick the team you face this week to see the categories you project to win and lose: each roster&apos;s projected line over the games
          left this fantasy week (Monday to Sunday).
        </p>
      ) : points ? (
        <p className="mt-1 text-sm" data-testid="matchup-summary">
          You project <strong>{fmt(match.mine.fpts, 0)} fantasy points</strong> to {them}&apos;s {fmt(match.theirs.fpts, 0)} this week, over{' '}
          {match.mine.games} games to their {match.theirs.games}.
        </p>
      ) : (
        <>
          <p className="mt-1 text-base font-medium" data-testid="matchup-call">
            {matchupCall(match, word)}.
            {swing && openDays.length > 0 && (
              <>
                {' '}
                <a href={pickups} className={link} data-testid="matchup-stream">
                  Stream {word(swing)} {openDays.map(dayName).join('/')} →
                </a>
              </>
            )}
          </p>
          {stream && openDays.length > 0 && <StreamLine stream={stream} league={league} nameOf={nameOf} pickups={pickups} />}
          <p className="mt-1 text-sm" data-testid="matchup-summary">
            {live ? 'From the score so far plus the games each lineup starts, you' : 'You'} project to{' '}
            <strong>
              win {match.wins} of {match.cats.length} categories
            </strong>{' '}
            against {them}, lose {match.losses}
            {match.close ? `, with ${match.close} too close to call (within 5%)` : ''}. Games left this week: you {match.mine.games}, {them}{' '}
            {match.theirs.games}.
          </p>
          {note && (
            <p className="mt-1 text-xs text-muted" data-testid="matchup-basis">
              {note}
            </p>
          )}
          <div className="table-scroll mt-2 overflow-auto" tabIndex={0} role="region" aria-label="Matchup, category by category">
            <table className="w-full text-sm" data-testid="matchup-table">
              <thead>
                <tr>
                  <Th>Category</Th>
                  <Th right>You</Th>
                  <Th right>{them}</Th>
                  <Th right>Edge</Th>
                  <Th>{''}</Th>
                </tr>
              </thead>
              <tbody>
                {match.cats.map((r) => (
                  <tr key={r.cat} className="border-t border-line" data-testid="matchup-row">
                    <Td>
                      {CATEGORY_LABELS[r.cat] ?? r.cat}
                      {r.cat === swing && <span className="ml-1 text-xs text-muted">swing</span>}
                    </Td>
                    <Td right>{show(r.cat, r.mine)}</Td>
                    <Td right>{show(r.cat, r.theirs)}</Td>
                    <Td right>
                      <Signed value={isRatio(r.cat) ? r.edge * 100 : r.edge} digits={isRatio(r.cat) ? 1 : 0} />
                    </Td>
                    <Td>
                      <span className={`text-xs font-semibold uppercase ${tone(r.result)}`}>{r.result}</span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
