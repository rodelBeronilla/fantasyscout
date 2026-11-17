import { describe, expect, it } from 'vitest';

import { type Capture, FIXTURE_LEAGUE, fixtureName, leftovers, namesIn, replacements, scrub, variants } from './yahoo-scrub';

// an invented league: team and manager names that hold the traps a real one might
const capture: Capture = {
  capturedAt: '2026-11-17T12:00:00Z',
  leagueId: '98765',
  pages: [
    {
      url: 'https://basketball.fantasysports.yahoo.com/nba/98765/startingrosters',
      status: 200,
      html: `<nav><a href="/nba/98765/2">My Team</a></nav>
        <p><a href="/nba/98765/1">Scott&#39;s Squad</a> <a href="https://profiles.sports.yahoo.com/user/ABC">Scott</a></p>
        <p><a href="/nba/98765/2">Hoops &amp; Dreams</a> <span class="Fz-xs manager-name">Dana</span></p>
        <table><tr><td>C</td><td><a href="https://sports.yahoo.com/nba/players/1">Scottie Barnes</a></td></tr></table>
        <p>League 98765 · league key nba.l.98765 · 1987654</p>`,
    },
    {
      url: 'https://basketball.fantasysports.yahoo.com/nba/98765/matchup?week=5&mid1=1&mid2=2',
      status: 200,
      html: `<a href="/nba/98765/1">Scott’s Squad</a> vs <a href="/nba/98765/2">Hoops &amp; Dreams</a> · Scott%27s+Squad`,
    },
  ],
};

describe('fixtures from the owner’s pages, with nothing that names his league (#1030)', () => {
  it('finds the team names and the manager names', () => {
    // the same team spelt with either apostrophe is one name with two forms
    const { teams, managers } = namesIn(capture);
    expect(teams.map((t) => t.replace('’', "'"))).toEqual(expect.arrayContaining(['Hoops & Dreams', "Scott's Squad"]));
    expect(managers).toEqual(['Dana', 'Scott']);
    expect(namesIn(capture, ['Extra Person', ' ']).managers).toContain('Extra Person');
  });

  it('replaces every form of each name, whole words only, and the league id where it is a whole number', () => {
    const names = namesIn(capture);
    const pairs = replacements(names);
    const pages = capture.pages.map((p) => scrub(p.html, capture.leagueId, pairs));
    const all = pages.join('\n');
    expect(all).not.toMatch(/Scott['’]s|Scott&#39;s|Hoops|Dana|(?<!\d)98765(?!\d)/);
    // a manager called Scott leaves Scottie Barnes alone; a number holding the id is not the id
    expect(all).toContain('Scottie Barnes');
    expect(all).toContain('1987654');
    expect(all).toContain(`/nba/${FIXTURE_LEAGUE}/1`);
    expect(leftovers(pages, capture.leagueId, [...names.teams, ...names.managers])).toEqual([]);
  });

  it('refuses when an original is left: the run writes nothing', () => {
    const names = namesIn(capture);
    expect(leftovers(capture.pages.map((p) => p.html), capture.leagueId, [...names.teams, ...names.managers])).toEqual(
      expect.arrayContaining(['the league id', 'Scott', 'Dana', 'Hoops & Dreams']),
    );
    // a name inside a page's embedded JSON is found and replaced too
    expect(leftovers(['{"name":"Scott\\u0027s Squad"}'], capture.leagueId, ["Scott's Squad"])).toEqual(["Scott's Squad"]);
    expect(scrub('{"name":"Hoops \\u0026 Dreams"}', capture.leagueId, [['Hoops & Dreams', 'Team A']])).toBe('{"name":"Team A"}');
    // an escaped or encoded form still counts as the name
    expect(leftovers(['Hoops &amp; Dreams'], capture.leagueId, ['Hoops & Dreams'])).toEqual(['Hoops & Dreams']);
    expect(variants("Scott's Squad")).toEqual(expect.arrayContaining(['Scott&#39;s Squad', 'Scott’s Squad', "Scott's%20Squad", "Scott's+Squad", 'Scott%27s+Squad']));
  });

  it('names each fixture by its page, without the league id', () => {
    const taken = new Set<string>();
    expect(fixtureName('https://x/nba/98765/', '98765', taken)).toBe('home.html');
    expect(fixtureName('https://x/nba/98765/3', '98765', taken)).toBe('team-3.html');
    expect(fixtureName('/nba/98765/matchup?week=5&mid1=1&mid2=2', '98765', taken)).toBe('matchup-week-5.html');
    expect(fixtureName('/nba/98765/matchup?week=5&mid1=3&mid2=4', '98765', taken)).toBe('matchup-week-5-2.html');
    expect(fixtureName('/nba/98765/settings', '98765', taken)).toBe('settings.html');
  });
});
