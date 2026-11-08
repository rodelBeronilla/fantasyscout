import { describe, expect, it } from 'vitest';
import { BASIS_HELP, LINE, lineColumns, VIEWS } from './board-views';

describe('the board views', () => {
  it('lists each view once, each with a label and its help', () => {
    const ids = VIEWS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['value', 'season', 'last20', 'recent', 'projected', 'pergame']);
    for (const v of VIEWS) {
      expect(v.label).not.toBe('');
      expect(v.help).not.toBe('');
    }
  });

  it("reads this season's line as it is, and the projection's under proj_", () => {
    expect(lineColumns('pergame')).toEqual(LINE);
    const projected = lineColumns('projected');
    expect(projected.map((c) => c.key)).toEqual(LINE.map((c) => `proj_${c.key}`));
    expect(projected.map((c) => [c.label, c.kind])).toEqual(LINE.map((c) => [c.label, c.kind]));
  });

  it('keeps the line columns it was given', () => {
    const before = LINE.map((c) => c.key);
    lineColumns('projected');
    expect(LINE.map((c) => c.key)).toEqual(before);
  });

  it('says what each basis of the value counts', () => {
    expect(Object.keys(BASIS_HELP).sort()).toEqual(['pergame', 'rest', 'season']);
  });
});
