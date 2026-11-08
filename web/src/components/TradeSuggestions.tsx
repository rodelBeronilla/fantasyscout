/** Suggested trades: packages from the open side's roster that win the manager categories, or that make the trade about even. */
import type { Suggestion } from '../lib/trade-suggest';
import { button, EffectCell, WinWin } from './TradeParts';
import { Card, Signed, Td, Th, Unvalidated } from './ui';

export function TradeSuggestions({
  suggestions,
  byStandings,
  winWin,
  onWinWin,
  nameList,
  partnerName,
  partnerRoster,
  open,
  mineEmpty,
  theirsEmpty,
  rest,
  h2h,
  points,
  onUse,
}: {
  suggestions: Suggestion[];
  /** The standings are in: suggestions are ranked by the categories they win. */
  byStandings: boolean;
  winWin: boolean;
  onWinWin: (on: boolean) => void;
  nameList: (ids: string[]) => string;
  partnerName: string;
  /** The partner's name in the prompt to add its roster. */
  partnerRoster: string;
  /** The side the packages come from. */
  open: 'give' | 'get';
  /** The manager's roster has no active players. */
  mineEmpty: boolean;
  /** The partner's roster has no active players. */
  theirsEmpty: boolean;
  /** What the value counts, in words. */
  rest: string;
  h2h: boolean;
  points: boolean;
  onUse: (s: Suggestion) => void;
}) {
  return (
    <Card title="Suggested trades" id="suggestions" badge={<Unvalidated issue={887} what="The suggestions" />}>
      {byStandings && <WinWin on={winWin} onChange={onWinWin} />}
      {suggestions.length ? (
        <>
          {/* A phone gets a stacked list, so each suggestion's button is on screen (#455); wider screens the table. */}
          <ul className="grid gap-2 text-sm md:hidden" data-testid="trade-suggestions-list">
            {suggestions.map((s) => (
              <li key={`${s.give.join()}>${s.get.join()}`} className="grid gap-1 rounded border border-line p-2">
                <p>
                  <span className="text-xs text-muted">You give </span>
                  {nameList(s.give)}
                </p>
                <p>
                  <span className="text-xs text-muted">You get </span>
                  {nameList(s.get)}
                </p>
                {s.effect && (
                  <p className="flex flex-wrap items-center gap-x-2">
                    <span className="text-xs text-muted">Your categories </span>
                    <EffectCell effect={s.effect} />
                  </p>
                )}
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>
                    <span className="text-xs text-muted">Value </span>
                    <Signed value={s.net} digits={1} />
                  </span>
                  {s.effect && (
                    <span>
                      <span className="text-xs text-muted">{partnerName} </span>
                      <Signed value={s.effect.partnerGain} digits={2} />
                    </span>
                  )}
                </p>
                <button type="button" className={`${button} justify-self-start`} onClick={() => onUse(s)}>
                  Use this trade
                </button>
              </li>
            ))}
          </ul>
          <div className="table-scroll hidden overflow-auto md:block" tabIndex={0} role="region" aria-label="Suggested trades">
            <table className="w-full text-sm" data-testid="trade-suggestions">
              <thead>
                <tr>
                  <Th>You give</Th>
                  <Th>You get</Th>
                  {byStandings && <Th>Your categories</Th>}
                  {byStandings && <Th right>{partnerName}</Th>}
                  <Th right>Value</Th>
                  <Th>{''}</Th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((s) => (
                  <tr key={`${s.give.join()}>${s.get.join()}`} className="border-t border-line">
                    <Td>{nameList(s.give)}</Td>
                    <Td>{nameList(s.get)}</Td>
                    {byStandings && <Td>{s.effect ? <EffectCell effect={s.effect} /> : '–'}</Td>}
                    {byStandings && (
                      <Td right>
                        <Signed value={s.effect?.partnerGain ?? null} digits={2} />
                      </Td>
                    )}
                    <Td right>
                      <Signed value={s.net} digits={1} />
                    </Td>
                    <Td>
                      <button type="button" className={button} onClick={() => onUse(s)}>
                        Use this trade
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted" data-testid="trade-no-suggestions">
          {open === 'give' && mineEmpty
            ? 'Add your own roster on the League page to see what you could offer.'
            : open === 'get' && theirsEmpty
              ? `Add ${partnerRoster}’s roster on the League page to see what you could ask for.`
              : byStandings
                ? `No package of up to three players from ${open === 'give' ? 'your' : `${partnerName}’s`} roster raises your expected categories won on terms ${partnerName} could accept${winWin ? ' (win-win only: theirs must rise too)' : ''}. Try another partner, or a different player.`
                : `No package of up to three players from ${open === 'give' ? 'your' : `${partnerName}’s`} roster comes within 15% of the other side for the ${rest}. Try another partner, or a different player.`}
        </p>
      )}
      <p className="mt-2 text-xs text-muted">
        {open === 'give' ? 'Packages from your roster' : `Packages from ${partnerName}’s roster`}
        {byStandings
          ? ` that raise the categories you expect to win, biggest gain first, among trades ${partnerName} could accept: ${winWin ? 'win-win only, so their expected categories rise too' : 'they give up at most 15% in value, or their own categories rise'}. The value can favour ${partnerName}; what counts is the categories. Your categories: the change in the categories you expect to win ${h2h ? 'a week' : '(rotisserie points)'}; ${partnerName}: theirs. Pick one to load it into the trade and see the full breakdown.`
          : ` that bring the two sides within 15% of each other for the ${rest}, the ones that favour you most first.${
              points ? '' : ' Enter half or more of a second team’s roster on the League page to rank them by the categories they win you instead.'
            }`}
      </p>
    </Card>
  );
}
