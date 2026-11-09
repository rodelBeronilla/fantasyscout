/**
 * The Trade page's scorecard (#694): the verdict at a glance. One call (fair, favours a side, a
 * judgment call, or bad for you), the three lenses it rests on as tiles, and the two teams side by
 * side. The full reasoning stays below it, folded.
 */
import type { ReactNode } from 'react';

import { CATEGORY_LABELS, fmt } from '../lib/format';
import type { Fairness } from '../lib/trade-fairness';
import type { Objective, TeamNeeds, TradeImpact } from '../lib/trade-impact';
import { Signed } from './ui';

export type Call = 'fair' | 'you' | 'partner' | 'judgment' | 'bad';

/** The one call the scorecard leads with. */
function callOf(fair: Fairness): Call {
  if (fair.severity !== 'fine') return 'bad';
  if (fair.even) return 'fair';
  if (fair.disagree) return 'judgment';
  const lean = (fair.categories ?? 0) * 10 + fair.value.share;
  return lean >= 0 ? 'you' : 'partner';
}

const TONE: Record<Call, string> = {
  fair: 'border-good text-good',
  you: 'border-good text-good',
  partner: 'border-warn text-warn',
  judgment: 'border-warn text-warn',
  bad: 'border-bad text-bad',
};

/** A lens's lean, or "Even" within the band where the lens calls the sides even. */
const share = (s: number, partner: string, even: number) =>
  Math.abs(s) <= even ? `Even${Math.abs(s) >= 0.005 ? ` (${s >= 0 ? 'you' : partner} +${Math.round(Math.abs(s) * 100)}%)` : ''}` : `${s >= 0 ? 'you' : partner} +${Math.round(Math.abs(s) * 100)}%`;
/** Green or red only past the even band, so a 2% lean does not read as a loss. */
const toneOf = (x: number, even: number) => (x > even ? 'text-good' : x < -even ? 'text-bad' : '');

function Tile({ label, value, sub, testid, tone }: { label: string; value: ReactNode; sub: ReactNode; testid: string; tone: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-bg p-2 sm:p-3" data-testid={testid}>
      <p className="text-[10px] font-medium tracking-wide text-muted uppercase sm:text-xs">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold tabular-nums sm:text-lg ${tone}`}>{value}</p>
      <p className="hidden text-xs text-muted sm:block">{sub}</p>
    </div>
  );
}

const cats = (list: string[]) => (list.length ? list.map((c) => CATEGORY_LABELS[c] ?? c).join(', ') : '–');

export function TradeScorecard({
  fair,
  impact,
  needs,
  objective,
  calls,
  partnerName,
  h2h,
  nameList,
  threshold,
}: {
  fair: Fairness;
  impact: TradeImpact | null;
  needs: { mine: TeamNeeds; partner: TeamNeeds } | null;
  objective: Objective | null;
  /**
   * The verdict's calls show: "fair", "favours" and the value and market leans. They failed their
   * check (#886), so only "Bad for you" shows, beside the warning (ADR 0023).
   */
  calls: boolean;
  partnerName: string;
  h2h: boolean;
  nameList: (ids: string[]) => string;
  /** The smallest change in expected categories worth calling (trade-impact.ts, meaningful). */
  threshold: number;
}) {
  const call = callOf(fair);
  const headline: Record<Call, string> = {
    fair: `Fair trade: ${[impact && fair.categories !== null ? 'your categories' : null, 'projected value', fair.market ? 'the market' : null].filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' and $1')} agree.`,
    you: 'Favours you.',
    partner: `Favours ${partnerName}.`,
    judgment: 'A judgment call: our projections and the market point opposite ways.',
    bad: 'Bad for you.',
  };
  const unit = h2h ? 'a week' : 'roto points';
  const both = objective
    ? {
        'win-win': 'Both teams gain categories.',
        you: `You gain categories; ${partnerName} does not.`,
        them: `${partnerName} gains categories; you do not.`,
        even: 'Neither team’s categories move much.',
        neither: 'Neither team gains categories.',
      }[objective]
    : null;
  const callShown = calls || call === 'bad';
  return (
    <div className="grid gap-3" data-testid="trade-scorecard">
      {callShown && (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`rounded-full border-2 px-3 py-0.5 text-sm font-semibold ${TONE[call]}`} data-testid="trade-call">
          {{ fair: 'Fair', you: 'Favours you', partner: `Favours ${partnerName}`, judgment: 'Judgment call', bad: 'Bad for you' }[call]}
        </span>
        <p className="text-base">{headline[call]}</p>
        {both && <p className="text-sm text-muted">{both}</p>}
      </div>
      )}
      <div className={`grid gap-2 ${calls ? 'grid-cols-3' : 'grid-cols-1'}`}>
        {impact && fair.categories !== null ? (
          <Tile
            testid="lens-categories"
            label="Your categories"
            tone={toneOf(fair.categories, threshold)}
            value={
              <>
                <Signed value={impact.mine.gain} digits={2} /> {h2h ? 'a week' : 'pts'}
              </>
            }
            sub={
              <>
                {fmt(impact.mine.scoreBefore, h2h ? 2 : 1)} → {fmt(impact.mine.scoreAfter, h2h ? 2 : 1)} {h2h ? 'expected wins' : 'roto points'}
              </>
            }
          />
        ) : (
          <Tile testid="lens-categories" label="Your categories" tone="text-muted" value="–" sub="Enter a second team's roster on the League page" />
        )}
        {calls && (
        <Tile
          testid="lens-value"
          label="Projected value"
          tone={toneOf(fair.value.share, 0.1)}
          value={share(fair.value.share, partnerName, 0.1)}
          sub={
            <>
              you give {fmt(fair.value.give, 1)}, get {fmt(fair.value.get, 1)}
            </>
          }
        />
        )}
        {calls && (fair.market ? (
          <Tile
            testid="lens-market"
            label="The market"
            tone={toneOf(fair.market.share, 0.15)}
            value={share(fair.market.share, partnerName, 0.15)}
            sub="ESPN ranks, priced on this board"
          />
        ) : (
          <Tile testid="lens-market" label="The market" tone="text-muted" value="–" sub="ESPN ranks none of these players" />
        ))}
      </div>
      {impact && needs && (
        <div className="table-scroll overflow-auto" tabIndex={0} role="region" aria-label="Both teams">
          <table className="w-full text-sm" data-testid="trade-both-sides">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1 pr-3 font-medium">{''}</th>
                <th className="py-1 pr-3 font-medium">You</th>
                <th className="py-1 font-medium">{partnerName}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-line">
                <td className="py-1 pr-3 text-muted">Expected categories {unit}</td>
                <td className="py-1 pr-3 tabular-nums">
                  {fmt(impact.mine.scoreBefore, 2)} → {fmt(impact.mine.scoreAfter, 2)} (<Signed value={impact.mine.gain} digits={2} />)
                </td>
                <td className="py-1 tabular-nums">
                  {fmt(impact.partner.scoreBefore, 2)} → {fmt(impact.partner.scoreAfter, 2)} (<Signed value={impact.partner.gain} digits={2} />)
                </td>
              </tr>
              <tr className="border-t border-line">
                <td className="py-1 pr-3 text-muted">Categories up</td>
                <td className="py-1 pr-3 text-good">{cats(impact.ups)}</td>
                <td className="py-1 text-good">{cats(impact.partnerUps)}</td>
              </tr>
              <tr className="border-t border-line">
                <td className="py-1 pr-3 text-muted">Categories down</td>
                <td className="py-1 pr-3 text-bad">{cats(impact.downs)}</td>
                <td className="py-1 text-bad">{cats(impact.partnerDowns)}</td>
              </tr>
              <tr className="border-t border-line">
                <td className="py-1 pr-3 text-muted">Swing categories</td>
                {(['mine', 'partner'] as const).map((side) => {
                  const up = side === 'mine' ? impact.ups : impact.partnerUps;
                  const down = side === 'mine' ? impact.downs : impact.partnerDowns;
                  return (
                    <td key={side} className={`py-1 ${side === 'mine' ? 'pr-3' : ''}`}>
                      {needs[side].swing.map((c, i) => (
                        <span key={c} className={up.includes(c) ? 'text-good' : down.includes(c) ? 'text-bad' : ''}>
                          {i > 0 ? ', ' : ''}
                          {CATEGORY_LABELS[c] ?? c}
                          {up.includes(c) ? ' ↑' : down.includes(c) ? ' ↓' : ''}
                        </span>
                      ))}
                    </td>
                  );
                })}
              </tr>
              <tr className="border-t border-line">
                <td className="py-1 pr-3 text-muted">Roster move</td>
                <td className="py-1 pr-3">
                  {impact.sides.mine.dropped.length ? `Drop ${nameList(impact.sides.mine.dropped)}` : impact.sides.mine.added.length ? `Add ${nameList(impact.sides.mine.added)}` : '–'}
                </td>
                <td className="py-1">
                  {impact.sides.partner.dropped.length
                    ? `Drop ${nameList(impact.sides.partner.dropped)}`
                    : impact.sides.partner.added.length
                      ? `Add ${nameList(impact.sides.partner.added)}`
                      : '–'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
