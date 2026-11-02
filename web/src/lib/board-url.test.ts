import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS, readBoardFilters, writeBoardFilters } from './board-url';

describe('board filters in the URL', () => {
  it('writes nothing for the defaults and keeps the other parameters', () => {
    expect(writeBoardFilters('', DEFAULT_FILTERS)).toBe('');
    expect(writeBoardFilters('?league=nba', DEFAULT_FILTERS)).toBe('?league=nba');
    expect(readBoardFilters('?league=nba')).toEqual(DEFAULT_FILTERS);
  });

  it('round-trips a punt-FT%, 20+ MPG, healthy board', () => {
    const f = {
      ...DEFAULT_FILTERS,
      view: 'last20' as const,
      punts: new Set(['z_free_throw_pct', 'z_turnovers']),
      minMinutes: 20,
      availability: 'healthy' as const,
      positions: new Set(['G' as const, 'C' as const]),
      team: 'LVA',
      countGames: false,
      restOfSeason: true,
      rookiesOnly: true,
      movedOnly: true,
      watchOnly: true,
      minGames: 10,
    };
    const qs = writeBoardFilters('?league=wnba', f);
    expect(qs).toBe('?league=wnba&view=last20&punt=ft-to&ros=1&games=0&team=LVA&pos=gc&gp=10&mpg=20&avail=healthy&rookies=1&moved=1&watch=1');
    expect(readBoardFilters(qs)).toEqual(f);
  });

  it('replaces its own parameters rather than adding to them', () => {
    const qs = writeBoardFilters('?league=nba&mpg=30&punt=pts', { ...DEFAULT_FILTERS, minMinutes: 15 });
    expect(qs).toBe('?league=nba&mpg=15');
  });

  it('drops what does not parse', () => {
    const f = readBoardFilters('?view=nope&punt=ft-xyz&team=<b>&pos=qz&gp=-3&mpg=abc&avail=maybe&rookies=yes');
    expect(f).toEqual({ ...DEFAULT_FILTERS, punts: new Set(['z_free_throw_pct']) });
  });
});
