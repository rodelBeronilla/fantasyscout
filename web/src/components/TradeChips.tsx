/** Trade chips and targets for a punt build (#671): players the build values differently from the rest of the league. */
import { CATEGORY_LABELS } from '../lib/format';
import type { BuildRank } from '../lib/punt-chips';
import { button } from './TradeParts';
import { Card } from './ui';

export function TradeChips({
  chips,
  targets,
  punted,
  teams,
  nameOf,
  ownerName,
  onOffer,
  onAskFor,
}: {
  /** The manager's players worth more to others than to the build. */
  chips: BuildRank[];
  /** Players elsewhere worth more to the build than to the league. */
  targets: BuildRank[];
  punted: string[];
  /** Teams in the league: a round of the draft, in places. */
  teams: number;
  nameOf: (id: string) => string;
  /** The name of the team that has the player. */
  ownerName: (id: string) => string;
  onOffer: (id: string) => void;
  onAskFor: (id: string) => void;
}) {
  return (
    <Card title="Trade chips and targets for your punt" id="chips">
      <p className="mb-3 text-sm text-muted">
        Punting {punted.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}, you rank players differently from the rest of your league. For you: the
        player&apos;s rank on value over the categories you keep. On value: the rank over every category, roughly where other managers see the player.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="mb-1 text-sm font-semibold">Chips: worth more to others</h3>
          {chips.length ? (
            <ul className="grid gap-1 text-sm" data-testid="trade-chips">
              {chips.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-x-2">
                  <span className="min-w-0 flex-1 truncate">{nameOf(v.id)}</span>
                  <span className="text-xs text-muted">
                    #{v.league} on value, #{v.build} for you
                  </span>
                  <button type="button" className={button} onClick={() => onOffer(v.id)}>
                    Offer
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">None of your players is worth much more to others than to your build.</p>
          )}
        </div>
        <div>
          <h3 className="mb-1 text-sm font-semibold">Targets: worth more to you</h3>
          {targets.length ? (
            <ul className="grid gap-1 text-sm" data-testid="trade-targets">
              {targets.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-x-2">
                  <span className="min-w-0 flex-1 truncate">
                    {nameOf(v.id)} <span className="text-xs text-muted">{ownerName(v.id)}</span>
                  </span>
                  <span className="text-xs text-muted">
                    #{v.league} on value, #{v.build} for you
                  </span>
                  <button type="button" className={button} onClick={() => onAskFor(v.id)}>
                    Ask for
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No player on another roster is worth much more to your build than to the league, among those who would start for you.</p>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">
        Ranks on rest-of-season value above replacement, over every player on the board; listed when they differ by a round ({teams} places) or
        more. A chip is a player to sell: other managers pay for categories you do not use. A target is one to buy for less than the player is worth to you,
        among players who would start for you (ranked for you at least as high as your median player).
      </p>
    </Card>
  );
}
