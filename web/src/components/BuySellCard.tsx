/** Buy low, sell high (#739): players whose last ten games run well off their projection. */
import type { League } from '../lib/data';
import { fmt } from '../lib/format';
import type { buySell, FormSwing } from '../lib/buy-sell';
import { PARAMS } from '../generated/parameters';
import { Card, Unvalidated } from './ui';

/** One line of the Buy & sell lists: the player, the run against the projection, and the action. */
function SwingRow({ s, name, team, action, onAction }: { s: FormSwing; name: string; team: string | null; action: string; onAction: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2" data-testid="swing">
      <span className="min-w-0 flex-1 truncate">
        {name} {team && <span className="text-xs text-muted">{team}</span>}
      </span>
      <span className="text-xs text-muted" title="Value per game above replacement: the last ten games against the projection">
        {fmt(s.recent, 1)} lately vs {fmt(s.projected, 1)} projected
      </span>
      <button type="button" className="rounded-full border border-line px-3 py-1 text-xs hover:bg-bg" onClick={onAction}>
        {action}
      </button>
    </li>
  );
}

export function BuySellCard({
  swings,
  sellHigh,
  league,
  nameOf,
  teamName,
  onOffer,
  onAskFor,
}: {
  swings: ReturnType<typeof buySell>;
  /** Sell high shows: it failed its check (#903), so it is off for now. */
  sellHigh: boolean;
  league: League;
  nameOf: (id: string) => string;
  /** A team's name, by index. */
  teamName: (team: number) => string | null;
  /** Put one of the manager's players on the give side. */
  onOffer: (id: string) => void;
  /** Ask a team for its player: the team becomes the partner. */
  onAskFor: (team: number, id: string) => void;
}) {
  return (
    <Card title={sellHigh ? 'Buy low, sell high' : 'Buy low'} id="buy-sell">
      <p className="mb-3 text-sm text-muted">
        Recent form against the projection, in value per game above replacement under your league&apos;s scoring. Managers price players on the box
        scores they have just seen: {sellHigh ? 'a hot run sells for more than the projection says, a slump buys for less' : 'a slump buys for less than the projection says'}.
      </p>
      <div className={`grid gap-4 ${sellHigh ? 'md:grid-cols-2' : ''}`}>
        {sellHigh && (
        <div>
          <h3 className="mb-1 text-sm font-semibold">
            Sell high: yours, running hot
            <Unvalidated issue={903} what="Sell high" />
          </h3>
          {swings.sellHigh.length ? (
            <ul className="grid gap-1 text-sm" data-testid="sell-high">
              {swings.sellHigh.map((s) => (
                <SwingRow key={s.id} s={s} name={nameOf(s.id)} team={null} action="Offer" onAction={() => onOffer(s.id)} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">None of your players is running {fmt(PARAMS['buysell.min_swing'][league], 1)} a game or more above the projection.</p>
          )}
        </div>
        )}
        <div>
          <h3 className="mb-1 text-sm font-semibold">
            Buy low: theirs, in a slump
            {league === 'wnba' && <Unvalidated issue={904} what="Buy low in the WNBA" />}
          </h3>
          {swings.buyLow.length ? (
            <ul className="grid gap-1 text-sm" data-testid="buy-low">
              {swings.buyLow.map((s) => (
                <SwingRow
                  key={s.id}
                  s={s}
                  name={nameOf(s.id)}
                  team={teamName(s.team)}
                  action="Ask for"
                  onAction={() => onAskFor(s.team, s.id)}
                />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No healthy player elsewhere who would start for you is slumping {fmt(PARAMS['buysell.min_swing'][league], 1)} a game or more below the projection.</p>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">
        Last ten games against the projection; a swing of {fmt(PARAMS['buysell.min_swing'][league], 1)} a game or more counts. Buy-low players are healthy (an injury explains a slump and is
        no discount) and projected at least as high as your median player.
      </p>
    </Card>
  );
}
