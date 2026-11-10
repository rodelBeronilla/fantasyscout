/**
 * The value bar beside a ranked player (#963): how much of the top value on show the player's value
 * is, drawn in the colour of the player's tier.
 */

/** A bar's colour: the tiers alternate the accent and the second colour; a player past the tiers is muted. */
export type BarTone = 'accent' | 'accent-2' | 'muted';

/** The share of the bar a value fills, from 0 to 1: nothing at or below replacement, all of it at the top value. */
export function barShare(value: number | null | undefined, top: number): number {
  if (value === null || value === undefined || Number.isNaN(value) || !(top > 0) || value <= 0) return 0;
  return Math.min(1, value / top);
}

/** The tone of a tier, counted from 1: odd tiers the accent, even tiers the second colour; no tier, muted. */
export function tierTone(tier: number | null | undefined): BarTone {
  if (!tier || tier < 1) return 'muted';
  return tier % 2 === 1 ? 'accent' : 'accent-2';
}
