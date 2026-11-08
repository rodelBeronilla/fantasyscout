/** The trade finder (#664): on request, the best trades with every partner in the league. */
import type { FoundTrade } from '../lib/trade-suggest';
import { button, EffectCell, WinWin } from './TradeParts';
import { Card, Signed, Unvalidated } from './ui';

export function TradeFinder({
  found,
  winWin,
  onWinWin,
  onFind,
  names,
  nameList,
  h2h,
  onUse,
}: {
  /** The trades found; null until asked for. */
  found: FoundTrade[] | null;
  winWin: boolean;
  onWinWin: (on: boolean) => void;
  onFind: () => void;
  /** The league's team names, by index. */
  names: string[];
  nameList: (ids: string[]) => string;
  h2h: boolean;
  /** Load a found trade into the Build tab. */
  onUse: (trade: FoundTrade) => void;
}) {
  return (
    <Card title="Trades across your league" id="finder" badge={<Unvalidated issue={888} what="The trade finder" />}>
      <WinWin on={winWin} onChange={onWinWin} />
      {!found ? (
        <div className="grid gap-2 text-sm">
          <p className="text-muted">
            One-for-one, two-for-one and one-for-two trades with every team, kept when they raise the categories you expect to win and give the other
            team a reason to say yes: their categories rise too, or they gain value.
          </p>
          <button type="button" className={`${button} justify-self-start`} onClick={onFind} data-testid="find-trades">
            Find trades
          </button>
        </div>
      ) : found.length ? (
        <ul className="grid gap-2 text-sm" data-testid="found-trades">
          {found.map((t) => (
            <li key={`${t.partner}:${t.give.join()}>${t.get.join()}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-line p-2">
              <span className="min-w-0">
                <strong>{names[t.partner]}</strong>
                <span className="text-muted">: you give </span>
                {nameList(t.give)}
                <span className="text-muted">, you get </span>
                {nameList(t.get)}
              </span>
              <span className="flex flex-wrap items-center gap-x-2">
                <span className="text-xs text-muted">Your categories</span>
                <EffectCell effect={t.effect} />
              </span>
              <span>
                <span className="text-xs text-muted">Theirs </span>
                <Signed value={t.effect.partnerGain} digits={2} />
              </span>
              <span>
                <span className="text-xs text-muted">Value </span>
                <Signed value={t.net} digits={1} />
              </span>
              <button type="button" className={button} onClick={() => onUse(t)}>
                Use this trade
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted" data-testid="found-none">
          {winWin
            ? 'No one-for-one, two-for-one or one-for-two trade raises the categories both teams expect to win. Untick win-win only to see trades that pay the other team in value instead.'
            : 'No one-for-one, two-for-one or one-for-two trade raises the categories you expect to win on terms the other team has a reason to accept.'}
        </p>
      )}
      {found && (
        <p className="mt-2 text-xs text-muted">
          Your categories: the change in the categories you expect to win {h2h ? 'a week' : '(rotisserie points)'}; theirs: the other
          team&apos;s. Biggest gain first, at most three a team, over each roster&apos;s eight most valuable players.
        </p>
      )}
    </Card>
  );
}
