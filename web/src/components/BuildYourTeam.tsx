/**
 * Build your team (#809): the category picture, the players worth going after and the players to
 * let go, each with the one move that makes it happen and a link to the page that makes it. The
 * numbers come from build-plan.ts; this file only lays them out.
 */
import type { ReactNode } from 'react';

import type { League } from '../lib/data';
import type { BuildPlan, CategoryLabel, CategoryStanding, Move, PlanPlayer } from '../lib/build-plan';
import { CATEGORY_LABELS, fmt, ordinal } from '../lib/format';
import { href } from '../lib/site';
import { PARAMS } from '../generated/parameters';
import { Badge, Signed, Tile } from './ui';

const label = (c: string) => CATEGORY_LABELS[c] ?? c;
const LABEL_TEXT: Record<CategoryLabel, string> = { swing: 'swing', locked: 'locked', conceding: 'conceding', weak: 'need', strong: 'strength' };
// A chip's colour by what matters most for a move: what is lost or needed first, then what is safe.
const TONE_ORDER: [CategoryLabel, 'bad' | 'good' | 'warn'][] = [
  ['conceding', 'bad'],
  ['weak', 'bad'],
  ['locked', 'good'],
  ['strong', 'good'],
  ['swing', 'warn'],
];

/** The Trade page with the players on each side, as its `?give=` and `?get=` links read them. */
function tradeLink(league: League, give: string[], get: string[]): string {
  const q = new URLSearchParams({ league });
  for (const id of give) q.append('give', id);
  for (const id of get) q.append('get', id);
  return href(`/trade/?${q.toString()}`);
}

interface Names {
  league: League;
  nameOf: (id: string) => string;
  detailOf: (id: string) => string;
  teamName: (team: number) => string;
  /** "cats" in head-to-head (expected categories won a week), "roto pts" in rotisserie. */
  unit: string;
}

function Chip({ s }: { s: CategoryStanding }) {
  const tone = TONE_ORDER.find(([l]) => s.labels.includes(l))?.[1] ?? 'muted';
  const parts = [
    label(s.cat),
    s.rank !== null && s.teams !== null ? `${ordinal(s.rank)} of ${s.teams}` : null,
    s.chance !== null ? `${Math.round(s.chance * 100)}%` : null,
    s.labels.map((l) => LABEL_TEXT[l]).join(', ') || null,
  ].filter(Boolean);
  return (
    <li data-testid="build-cat" data-cat={s.cat}>
      <Badge tone={tone}>{parts.join(' · ')}</Badge>
    </li>
  );
}

/** The move in a line: who comes in, who goes, and what it gains. */
function MoveText({ move, n }: { move: Move; n: Names }) {
  const list = (ids: string[]) => ids.map(n.nameOf).join(' + ');
  const gain = (
    <>
      {' '}
      (<Signed value={move.gain} digits={2} /> {n.unit})
    </>
  );
  if (move.kind === 'pickup') {
    return (
      <span data-testid="build-move" data-kind="pickup">
        Add {n.nameOf(move.add)}, drop {n.nameOf(move.drop)}
        {gain}
      </span>
    );
  }
  return (
    <span data-testid="build-move" data-kind="trade">
      Trade {list(move.give)} to {n.teamName(move.partner)} for {list(move.get)}
      {gain}
    </span>
  );
}

function Row({ p, kind, n, standings }: { p: PlanPlayer; kind: 'target' | 'let-go'; n: Names; standings: boolean }) {
  const why =
    p.reasons.length > 0
      ? `${kind === 'target' ? (standings ? 'adds' : 'best in') : 'costs'} ${p.reasons.map((r) => label(r.cat)).join(', ')}`
      : kind === 'let-go' && standings
        ? 'costs nothing you play for'
        : null;
  // A free agent goes to Pickups; anyone else, and every player let go, to Trade.
  const pickup = kind === 'target' && standings && p.team === null;
  const trade = p.move?.kind === 'trade' ? p.move : null;
  const link = pickup
    ? href(`/streamers/?league=${n.league}`)
    : kind === 'target'
      ? tradeLink(n.league, trade?.give ?? [], [p.id])
      : tradeLink(n.league, trade?.give ?? [p.id], trade?.get ?? []);
  const where = p.team === null ? (standings ? 'free agent' : null) : kind === 'target' ? n.teamName(p.team) : null;
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-t border-line py-1.5 first:border-t-0" data-testid="build-row" data-player={p.id}>
      <span className="min-w-0">
        <a href={href(`/p/${n.league}/${p.id}/`)} className="font-medium underline-offset-4 hover:underline">
          {n.nameOf(p.id)}
        </a>{' '}
        <span className="text-xs text-muted">{[n.detailOf(p.id), where].filter(Boolean).join(' · ')}</span>
      </span>
      {why && (
        <span className={`text-xs ${kind === 'target' ? 'text-good' : 'text-muted'}`} data-testid="build-why">
          {why}
        </span>
      )}
      {p.move && (
        <span className="text-sm">
          <MoveText move={p.move} n={n} />
        </span>
      )}
      <a href={link} className="text-xs font-medium text-accent underline-offset-4 hover:underline" data-testid="build-link">
        {pickup ? 'more on Pickups →' : 'more on Trade →'}
      </a>
    </li>
  );
}

function List({ title, testid, note, children }: { title: string; testid: string; note: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-3 min-w-0" data-testid={testid}>
      <h3 className="text-xs font-medium tracking-wide text-muted uppercase">{title}</h3>
      <p className="text-xs text-muted">{note}</p>
      <ul className="mt-1 text-sm">{children}</ul>
    </div>
  );
}

export function BuildYourTeam({
  plan,
  league,
  nameOf,
  detailOf,
  teamName,
  h2h,
}: {
  plan: BuildPlan;
  league: League;
  nameOf: (id: string) => string;
  detailOf: (id: string) => string;
  teamName: (team: number) => string;
  h2h: boolean;
}) {
  const n: Names = { league, nameOf, detailOf, teamName, unit: h2h ? 'cats' : 'roto pts' };
  const { standings } = plan;
  const won = h2h ? 'expected categories won a week' : 'expected rotisserie points';
  return (
    <Tile title="Build your team" id="build" testid="build-plan" issue={757}>
      <p className="mt-1 text-sm" data-testid="build-summary">
        {standings ? (
          <>
            For the rest of the season, by your {won} against the league: who to go after, who to let go, and the one move for each.
          </>
        ) : (
          <>
            For the rest of the season, by Fit&apos;s value weighted to the categories your team needs, across the whole board.{' '}
            <span className="text-muted" data-testid="build-import">
              Import your league to see swaps and trades: add the other teams&apos; rosters on the{' '}
              <a href={href('/league/')} className="underline underline-offset-4">
                League page
              </a>
              .
            </span>
          </>
        )}
      </p>
      <ul className="mt-2 flex flex-wrap gap-1" data-testid="build-picture" aria-label="Your categories">
        {plan.picture.map((s) => (
          <Chip key={s.cat} s={s} />
        ))}
      </ul>
      {plan.punted.length > 0 && <p className="mt-1 text-xs text-muted">Punted, counting for nothing: {plan.punted.map(label).join(', ')}.</p>}

      <List
        title="Targets"
        testid="build-targets"
        note={
          standings
            ? `Free agents and players on other rosters, by the ${won} they add in place of your least useful player.`
            : 'The best fits for your needs, wherever they are.'
        }
      >
        {plan.targets.length === 0 ? (
          <li className="text-muted">No player adds enough to your categories to be worth a move.</li>
        ) : (
          plan.targets.map((p) => <Row key={p.id} p={p} kind="target" n={n} standings={standings} />)
        )}
      </List>

      <div className="grid gap-x-4 lg:grid-cols-2">
        <List
          title="Let go: surplus to your build"
          testid="build-surplus"
          note={standings ? `The players whose loss costs the fewest ${won}.` : 'The lowest value weighted to your needs.'}
        >
          {plan.surplus.map((p) => (
            <Row key={p.id} p={p} kind="let-go" n={n} standings={standings} />
          ))}
        </List>
        <List title="Let go: lowest value" testid="build-lowest" note="The lowest rest-of-season value on your roster.">
          {plan.lowest.map((p) => (
            <Row key={p.id} p={p} kind="let-go" n={n} standings={standings} />
          ))}
        </List>
      </div>
      {standings && (
        <p className="mt-2 text-xs text-muted">
          A pickup drops only a player the roster review would drop; a trade must raise your categories by at least{' '}
          {fmt(PARAMS['trade.meaningful_gain'][league], 2)}
          {h2h ? ' a week' : ' per rival'}, pass the Trade page&apos;s fairness check, and give the other team a reason to say yes. No move leaves a
          position you cover empty.
        </p>
      )}
    </Tile>
  );
}
