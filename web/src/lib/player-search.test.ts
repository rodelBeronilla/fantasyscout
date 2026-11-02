import { describe, expect, it } from 'vitest';

import { matchOptions } from './player-search';

const labels = ['Luka Dončić · DAL · G', 'Nikola Jokić · DEN · C', 'Luka Garza · MIN · C', "A'ja Wilson · LVA · F"];

describe('matchOptions', () => {
  it('finds a player from part of a name, accents and case aside, best first', () => {
    expect(matchOptions(labels, 'luka')).toEqual(['Luka Dončić · DAL · G', 'Luka Garza · MIN · C']);
    expect(matchOptions(labels, 'DONCIC')).toEqual(['Luka Dončić · DAL · G']);
    expect(matchOptions(labels, 'jokic den')).toEqual(['Nikola Jokić · DEN · C']);
    expect(matchOptions(labels, 'aja')).toEqual(["A'ja Wilson · LVA · F"]);
  });

  it('returns nothing for no words or no match, and stops at the limit', () => {
    expect(matchOptions(labels, '  ')).toEqual([]);
    expect(matchOptions(labels, 'zzz')).toEqual([]);
    expect(matchOptions(labels, 'a', 2)).toHaveLength(2);
  });
});
