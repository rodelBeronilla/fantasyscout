/** Small pieces the Trade page's cards share: the button, a trade's category moves and the win-win toggle. */
import { CATEGORY_LABELS } from '../lib/format';
import type { CategoryEffect } from '../lib/trade-suggest';
import { Signed } from './ui';

export const button = 'rounded border border-line px-2 py-1 text-xs hover:bg-bg disabled:opacity-50';

const catList = (list: string[]) => list.map((c) => CATEGORY_LABELS[c] ?? c).join(', ');

/** The categories a change moves the manager's chances in, up and down. */
export function CatMoves({ ups, downs }: { ups: string[]; downs: string[] }) {
  return ups.length || downs.length ? (
    <span className="whitespace-nowrap">
      {ups.length > 0 && <span className="text-good">↑ {catList(ups)}</span>}
      {ups.length > 0 && downs.length > 0 && ' '}
      {downs.length > 0 && <span className="text-bad">↓ {catList(downs)}</span>}
    </span>
  ) : (
    <span className="text-muted">no category moves</span>
  );
}

/** A trade's change in the categories the manager expects to win, and the categories it moves. */
export function EffectCell({ effect }: { effect: CategoryEffect }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      <Signed value={effect.gain} digits={2} />
      <CatMoves ups={effect.ups} downs={effect.downs} />
    </span>
  );
}

/** Keep only trades that raise both teams' expected categories (#682). */
export function WinWin({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="mb-2 flex items-center gap-2 text-sm" title="Both teams' expected categories must rise">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} data-testid="win-win" />
      Win-win only
    </label>
  );
}
