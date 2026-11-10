import { describe, expect, it } from 'vitest';

import { barShare, tierTone } from './value-bar';

describe('barShare', () => {
  it('is the value over the top value on show', () => {
    expect(barShare(4.7, 9.4)).toBeCloseTo(0.5);
    expect(barShare(9.4, 9.4)).toBe(1);
  });

  it('is empty at or below replacement', () => {
    expect(barShare(0, 9.4)).toBe(0);
    expect(barShare(-1.2, 9.4)).toBe(0);
  });

  it('is empty without a value or a top value', () => {
    expect(barShare(null, 9.4)).toBe(0);
    expect(barShare(undefined, 9.4)).toBe(0);
    expect(barShare(Number.NaN, 9.4)).toBe(0);
    expect(barShare(3, 0)).toBe(0);
    expect(barShare(3, -2)).toBe(0);
  });

  it('never runs past the end of the bar', () => {
    expect(barShare(12, 9.4)).toBe(1);
  });
});

describe('tierTone', () => {
  it('alternates from the accent', () => {
    expect([1, 2, 3, 4].map(tierTone)).toEqual(['accent', 'accent-2', 'accent', 'accent-2']);
  });

  it('is muted past the tiers', () => {
    expect(tierTone(0)).toBe('muted');
    expect(tierTone(null)).toBe('muted');
    expect(tierTone(undefined)).toBe('muted');
  });
});
