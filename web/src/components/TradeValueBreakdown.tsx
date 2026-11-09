/** The Trade page's full breakdown in value: whether the trade is even (#692), and what each side is worth. */
import { CATEGORY_LABELS } from '../lib/format';
import { href } from '../lib/site';
import type { Fairness } from '../lib/trade-fairness';
import type { SideAfter } from '../lib/trade-impact';
import type { TradeSide } from '../lib/trade-players';
import { Signed } from './ui';

export function TradeValueBreakdown({
  fair,
  calls,
  settled,
  partnerName,
  nameList,
  hasImpact,
  net,
  rest,
  giving,
  getting,
  week,
  weekAvailable,
  spots,
  punted,
  points,
}: {
  fair: Fairness | null;
  /** The verdict's calls show: even or not, and which side the value favours. They failed their check (#886). */
  calls: boolean;
  /** The manager's drop or pickup the value counts, when the trade leaves the roster spots uneven. */
  settled: SideAfter | null;
  partnerName: string;
  nameList: (ids: string[]) => string;
  /** The categories are judged above it: the value comes second. */
  hasImpact: boolean;
  /** The value the manager gains: what they get less what they give. */
  net: number;
  /** What the value counts, in words: the rest of the season, this fantasy week or next season. */
  rest: string;
  giving: TradeSide;
  getting: TradeSide;
  week: boolean;
  weekAvailable: boolean;
  /** Players received less players sent. */
  spots: number;
  punted: string[];
  points: boolean;
}) {
  return (
    <>
      {fair && (
        <div className="grid gap-0.5 rounded border border-line p-2" data-testid="trade-fairness">
          {calls && (
            <p className="font-medium">
              {fair.even
                ? 'Even: projected value, the market and your categories all agree.'
                : fair.disagree
                  ? 'Not clearly even: our projections and the market point opposite ways.'
                  : 'Not even.'}
            </p>
          )}
          <p>
            <span className="text-muted">Projected value{settled ? ', roster spots counted' : ''}: </span>
            you give <Signed value={fair.value.give} digits={1} />, get <Signed value={fair.value.get} digits={1} />
            {calls && (
              <>
                {' '}({fair.value.net >= 0 ? 'you +' : 'partner +'}
                {Math.round(Math.abs(fair.value.share) * 100)}%)
              </>
            )}
          </p>
          {fair.market && (
            <p data-testid="trade-fairness-market">
              <span className="text-muted">The market (ESPN ranks, priced on this board): </span>
              you give <Signed value={fair.market.give} digits={1} />, get <Signed value={fair.market.get} digits={1} />
              {calls && (
                <>
                  {' '}({fair.market.net >= 0 ? 'you +' : 'partner +'}
                  {Math.round(Math.abs(fair.market.share) * 100)}%)
                </>
              )}
            </p>
          )}
          {calls && fair.disagree && (
            <p className="text-muted" data-testid="trade-fairness-disagree">
              Our projections favour {fair.value.net >= 0 ? 'you' : partnerName}; the market favours {fair.market && fair.market.net >= 0 ? 'you' : partnerName}.
              The market pays for stars and for names, the projections for production and games played: a trade between them is a bet that the
              projections are right, and most managers will judge it the market&apos;s way.
            </p>
          )}
          {settled && (
            <p className="text-muted">
              {settled.dropped.length > 0 && <>Your drop to make room ({nameList(settled.dropped)}) counts as given. </>}
              {settled.added.length > 0 && <>The free agent you would pick up ({nameList(settled.added)}) counts as received.</>}
            </p>
          )}
        </div>
      )}
      {calls && (
      <p className={hasImpact ? 'text-muted' : 'text-base'}>
        {hasImpact ? 'In value: ' : ''}
        {fair?.even ? (
          <>About even for the {rest}.</>
        ) : (fair?.value.net ?? net) > 0 ? (
          <>
            Favours you by <Signed value={fair?.value.net ?? net} digits={1} /> for the {rest}.
          </>
        ) : (
          <>
            Favours your partner by <Signed value={-(fair?.value.net ?? net)} digits={1} /> for the {rest}.
          </>
        )}
      </p>
      )}
      <p className="text-muted">
        You give <Signed value={giving.value} digits={1} /> and get <Signed value={getting.value} digits={1} /> for the {rest}:{' '}
        {week ? (
          <>
            each player&apos;s last-ten form above a replacement-level player under your league&apos;s scoring, counted over the games left
            this fantasy week (Monday to Sunday).
          </>
        ) : (
          <>
            value above a replacement-level player under your league&apos;s scoring, counted over the games each player is expected to play
            from today (injuries, return dates and the schedule included). Over the whole season it is{' '}
            <Signed value={giving.season} digits={1} /> for <Signed value={getting.season} digits={1} />.
          </>
        )}
      </p>
      {weekAvailable && (
        <p className="text-muted" data-testid="trade-week-games">
          Games left this fantasy week: {giving.games} for the players you give, {getting.games} for the players you get.
        </p>
      )}
      {[...giving.belowReplacement, ...getting.belowReplacement].length > 0 && (
        <p className="text-muted" data-testid="trade-below-replacement">
          {[...giving.belowReplacement, ...getting.belowReplacement].map((p) => p.full_name ?? p.player_id).join(', ')}{' '}
          {[...giving.belowReplacement, ...getting.belowReplacement].length === 1 ? 'is' : 'are'} below replacement level and
          count as zero: a free agent would do as well, so a trade gains nothing by sending or taking{' '}
          {[...giving.belowReplacement, ...getting.belowReplacement].length === 1 ? 'that player' : 'them'}.
        </p>
      )}
      {spots !== 0 && !hasImpact && (
        <p className="text-muted" data-testid="trade-spots">
          {spots > 0
            ? `You receive ${spots} more player${spots === 1 ? '' : 's'} than you send, so you would drop ${spots}. A dropped player is worth about replacement level, which the values above already count as zero.`
            : `You send ${-spots} more player${-spots === 1 ? '' : 's'} than you receive, freeing ${-spots} roster spot${-spots === 1 ? '' : 's'}. The best free agent fills each at about replacement level, so the values above already allow for it.`}
        </p>
      )}
      {punted.length > 0 && (
        <p className="text-muted" data-testid="trade-punts">
          Punting {punted.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}: values and categories leave {punted.length === 1 ? 'it' : 'them'} out
          (change the punts on the <a href={href('/league/')} className="underline underline-offset-4">League page</a> or the board).
        </p>
      )}
      {points && (
        <p className="text-muted">Your league scores points: the values are fantasy points per game above replacement, with your league&apos;s weights.</p>
      )}
    </>
  );
}
