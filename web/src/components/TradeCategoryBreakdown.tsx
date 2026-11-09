/** The Trade page's full breakdown in categories: what the trade does to both teams' expected categories (#663, #682). */
import { CATEGORY_LABELS, fmt } from '../lib/format';
import type { WeekMatchup } from '../lib/matchup';
import type { Objective, TeamNeeds, TradeImpact } from '../lib/trade-impact';
import { CatMoves } from './TradeParts';
import { Signed, Td, Th } from './ui';

/** This week's matchup before and after the trade (#674), and the categories that change hands. */
interface WeekMatch {
  before: WeekMatchup;
  after: WeekMatchup;
  flips: WeekMatchup['cats'];
  name: string;
}

const record = (m: { wins: number; losses: number; close: number }) => `${m.wins}–${m.losses}${m.close ? `–${m.close}` : ''}`;
/** Who the partner is likely to see it: their categories and their value. */
const acceptance = (partnerGain: number, partnerValue: number, scale: number) =>
  partnerGain >= 0 && partnerValue >= -0.05 * scale
    ? 'Good for them on both counts: a trade they have reason to accept.'
    : partnerGain >= 0
      ? 'Their categories improve though they give up value: worth offering to a manager who builds for categories.'
      : partnerValue >= 0
        ? 'They gain value but lose ground in their categories: a manager who goes by rankings may take it.'
        : 'They lose on both counts: unlikely to be accepted.';

export function TradeCategoryBreakdown({
  impact,
  threshold,
  h2h,
  catCount,
  verdictBoth,
  calls,
  partnerName,
  nameList,
  weekMatch,
  partnerValue,
  partnerCats,
  scale,
  needs,
  marketGive,
  marketGet,
}: {
  impact: TradeImpact;
  /** The least change in expected categories that counts. */
  threshold: number;
  h2h: boolean;
  /** The categories the league counts, less its punts. */
  catCount: number;
  verdictBoth: Objective | null;
  /** The verdict's calls show ("wins you categories", "about even", whether the partner would accept): they failed their check (#886). */
  calls: boolean;
  partnerName: string;
  nameList: (ids: string[]) => string;
  weekMatch: WeekMatch | null;
  /** The value the partner gains, under the partner's build: what they get less what they give (#938). */
  partnerValue: number;
  /** The categories the partner's build counts: every one the league scores (no team's punts are kept); null in a points league. */
  partnerCats: number | null;
  /** The larger side's value, at least 1. */
  scale: number;
  needs: { mine: TeamNeeds; partner: TeamNeeds } | null;
  /** ESPN's draft ranks of the players each side sends; empty when none is ranked. */
  marketGive: string;
  marketGet: string;
}) {
  return (
    <div className="grid gap-1" data-testid="trade-category-verdict">
      <p className="text-base">
        {calls && (
          <>
            <strong>
              {impact.mine.gain >= threshold ? 'Wins you categories' : impact.mine.gain <= -threshold ? 'Costs you categories' : 'About even in categories'}:
            </strong>{' '}
          </>
        )}
        {h2h ? (
          <>
            {calls ? 'you' : 'You'} would expect to win {fmt(impact.mine.scoreAfter, 2)} of your {catCount} categories in an average week against your league,
            from {fmt(impact.mine.scoreBefore, 2)} (<Signed value={impact.mine.gain} digits={2} />
            ).
          </>
        ) : (
          <>
            {calls ? 'your' : 'Your'} expected rotisserie points over your {catCount} categories go from {fmt(impact.mine.scoreBefore, 1)} to{' '}
            {fmt(impact.mine.scoreAfter, 1)} (<Signed value={impact.mine.gain} digits={1} />
            ).
          </>
        )}
      </p>
      {verdictBoth && (
        <p data-testid="trade-objective" className={verdictBoth === 'win-win' ? 'font-medium text-good' : verdictBoth === 'neither' ? 'text-bad' : ''}>
          {verdictBoth === 'win-win'
            ? 'Win-win: both teams expect to win more categories, an objectively good trade.'
            : verdictBoth === 'you'
              ? `Good for you only: ${partnerName} does not gain categories, so they have less reason to accept.`
              : verdictBoth === 'them'
                ? `Good for ${partnerName} only: they gain categories and you do not.`
                : verdictBoth === 'even'
                  ? 'About even for both teams’ categories.'
                  : 'Neither team gains categories.'}
        </p>
      )}
      {(impact.ups.length > 0 || impact.downs.length > 0) && <p><CatMoves ups={impact.ups} downs={impact.downs} /></p>}
      {(impact.sides.mine.dropped.length > 0 || impact.sides.mine.added.length > 0) && (
        <p className="text-muted" data-testid="trade-roster-moves">
          {impact.sides.mine.dropped.length > 0 && <>To make room you would drop {nameList(impact.sides.mine.dropped)}, your lowest-valued player after the trade. </>}
          {impact.sides.mine.added.length > 0 && <>You would pick up {nameList(impact.sides.mine.added)}, the best free agent, for the open spot. </>}
          The categories count {impact.sides.mine.dropped.length > 0 ? 'the drop' : 'the pickup'}.
        </p>
      )}
      {weekMatch && (
        <p data-testid="trade-week-matchup">
          <span className="text-muted">This week against {weekMatch.name}: </span>
          {record(weekMatch.before)} → <strong>{record(weekMatch.after)}</strong>
          <span className="text-muted"> (won–lost{weekMatch.before.close || weekMatch.after.close ? '–too close' : ''}, over the games left)</span>
          {weekMatch.flips.length > 0 ? (
            <>
              {'. '}
              {weekMatch.flips.map((r, i) => {
                const was = weekMatch.before.cats.find((b) => b.cat === r.cat)?.result ?? 'close';
                const better = (r.result === 'win' && was !== 'win') || (r.result === 'close' && was === 'loss');
                return (
                  <span key={r.cat} className={better ? 'text-good' : 'text-bad'}>
                    {i > 0 ? ', ' : ''}
                    {CATEGORY_LABELS[r.cat] ?? r.cat} {was} → {r.result}
                  </span>
                );
              })}
            </>
          ) : (
            <span className="text-muted">: no category changes hands.</span>
          )}
        </p>
      )}
      <div className="grid gap-1 rounded border border-line p-2" data-testid="trade-partner">
        <p>
          <span className="text-muted">For {partnerName}: </span>
          {h2h ? (
            <>
              {fmt(impact.partner.scoreBefore, 2)} → <strong>{fmt(impact.partner.scoreAfter, 2)}</strong> expected categories a week (
              <Signed value={impact.partner.gain} digits={2} />)
            </>
          ) : (
            <>
              {fmt(impact.partner.scoreBefore, 1)} → <strong>{fmt(impact.partner.scoreAfter, 1)}</strong> rotisserie points (
              <Signed value={impact.partner.gain} digits={1} />)
            </>
          )}{' '}
          and <Signed value={partnerValue} digits={1} /> in value.{calls && <span className="text-muted"> {acceptance(impact.partner.gain, partnerValue, scale)}</span>}
        </p>
        {partnerCats !== null && (
          <p className="text-xs text-muted" data-testid="trade-partner-build">
            {partnerName}&apos;s side is valued on all {partnerCats} categories your league scores: FantasyScout keeps no punts but yours, and guesses none from a roster.
          </p>
        )}
        {(impact.partnerUps.length > 0 || impact.partnerDowns.length > 0) && <p><CatMoves ups={impact.partnerUps} downs={impact.partnerDowns} /></p>}
        {(impact.sides.partner.dropped.length > 0 || impact.sides.partner.added.length > 0) && (
          <p className="text-muted">
            {impact.sides.partner.dropped.length > 0 && <>They would drop {nameList(impact.sides.partner.dropped)} to make room. </>}
            {impact.sides.partner.added.length > 0 && <>They would pick up {nameList(impact.sides.partner.added)}, the best free agent left. </>}
          </p>
        )}
      </div>
      {needs && (
        <div className="table-scroll overflow-auto" tabIndex={0} role="region" aria-label="Each team's needs">
          <table className="w-full text-sm" data-testid="trade-needs">
            <thead>
              <tr>
                <Th>Needs, from the standings</Th>
                <Th>You</Th>
                <Th>{partnerName}</Th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['Swing categories (close against the league)', 'swing'],
                  ['Conceding (under 25%)', 'conceding'],
                  ['Locked (over 75%)', 'locked'],
                ] as const
              ).map(([label, key]) => (
                <tr key={key} className="border-t border-line">
                  <Td>{label}</Td>
                  {(['mine', 'partner'] as const).map((side) => {
                    const list = needs[side][key];
                    const up = side === 'mine' ? impact.ups : impact.partnerUps;
                    const down = side === 'mine' ? impact.downs : impact.partnerDowns;
                    return (
                      <Td key={side}>
                        {list.length
                          ? list.map((c, i) => (
                              <span key={c} className={key === 'swing' ? (up.includes(c) ? 'text-good' : down.includes(c) ? 'text-bad' : '') : ''}>
                                {i > 0 ? ', ' : ''}
                                {CATEGORY_LABELS[c] ?? c}
                                {key === 'swing' ? (up.includes(c) ? ' ↑' : down.includes(c) ? ' ↓' : '') : ''}
                              </span>
                            ))
                          : '–'}
                      </Td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-muted">
            Swing categories are where a gain moves a team&apos;s chances most; an arrow shows the trade moving one up or down. A good trade for
            both sides helps each team&apos;s swing categories and costs it only categories it concedes or has locked.
          </p>
        </div>
      )}
      {(marketGive || marketGet) && (
        <p className="text-muted" data-testid="trade-market">
          ESPN draft ranks, which many managers trade by: you give {marketGive || 'none ranked'}, you get {marketGet || 'none ranked'}.
        </p>
      )}
    </div>
  );
}
