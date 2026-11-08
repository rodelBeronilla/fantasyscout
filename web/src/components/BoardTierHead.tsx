import { fmt } from '../lib/format';
import type { Tier } from '../lib/league-value';

/** A row of mutually exclusive buttons. */
function roundsLabel(t: Tier): string {
  return t.firstRound === t.lastRound ? `round ${t.firstRound}` : `rounds ${t.firstRound}–${t.lastRound}`;
}

/** The row that opens a tier: where its picks fall in a draft, its value range, and how many are left. */
export function TierHead({ tier, columns, left, size }: { tier: Tier | null; columns: number; left: number | null; size: number }) {
  return (
    <tr className="border-t-2 border-accent bg-bg" data-testid="tier-head">
      <td colSpan={columns} className="px-2 pt-2 pb-1 text-xs">
        <span className="sticky left-2 inline-block">
          {tier ? (
            <>
              <strong className="text-accent">Tier {tier.tier}</strong>{' '}
              <span className="text-muted">
                · {tier.start === tier.end ? `pick ${tier.start + 1}` : `picks ${tier.start + 1}–${tier.end + 1}`} ({roundsLabel(tier)}) · value {tier.start === tier.end ? fmt(tier.high, 1) : `${fmt(tier.high, 1)} to ${fmt(tier.low, 1)}`}
                {left !== null ? ` · ${left} of ${size} available` : ''}
              </span>
            </>
          ) : (
            <>
              <strong>Beyond the rostered pool</strong>{' '}
              <span className="text-muted">· players a league this size leaves on waivers</span>
            </>
          )}
        </span>
      </td>
    </tr>
  );
}
