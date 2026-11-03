import { describe, expect, it } from 'vitest';

import { parseLenientJson } from './lenient-json';

describe('parseLenientJson', () => {
  it('reads a bare NaN or Infinity value as null, and leaves the words alone inside a string', () => {
    const text = '{"rows": [["Touches trend", 2.83, NaN, null], [1, -Infinity, Infinity]], "x": NaN, "label": "NaN, Infinity"}';
    expect(parseLenientJson(text)).toEqual({ rows: [['Touches trend', 2.83, null, null], [1, null, null]], x: null, label: 'NaN, Infinity' });
  });
  it('parses plain JSON unchanged', () => {
    expect(parseLenientJson('{"a": [1, 2.5, "b"]}')).toEqual({ a: [1, 2.5, 'b'] });
  });
});
