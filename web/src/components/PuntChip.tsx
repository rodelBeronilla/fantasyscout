/**
 * The league's punts, read only (#938): one setting, edited on the League page, which every page
 * values players under. Nothing when the league punts nothing.
 */
import type { League } from '../lib/data';
import { CATEGORY_LABELS } from '../lib/format';
import { href } from '../lib/site';

export function PuntChip({ punts, league }: { punts: string[]; league: League }) {
  if (!punts.length) return null;
  return (
    <p className="w-fit rounded-full border border-line px-3 py-0.5 text-xs text-muted" data-testid="punt-chip">
      Your league: punting {punts.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')} ·{' '}
      <a href={href(`/league/?league=${league}#settings`)} className="font-medium text-accent underline-offset-4 hover:underline">
        Edit on League
      </a>
    </p>
  );
}
