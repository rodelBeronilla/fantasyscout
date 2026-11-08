import { CATEGORY_LABELS, fmt } from '../lib/format';
import type { PowerRank } from '../lib/standings';
import { Td, Th, Tile } from './ui';

/**
 * Every team with players, category by category (moved from the League page, #716): each team's
 * value per game above replacement summed over its active roster, the top third green and the
 * bottom third red; in a points league, its fantasy points a game. With the real standings above
 * it (#822) it sits one click down inside them (`inline`); without them, `note` says how to get them.
 */
export function LeagueTable({
  names,
  mine,
  rosters,
  il,
  cats,
  catValue,
  fpts,
  power,
  note,
  inline = false,
}: {
  names: string[];
  mine: number;
  rosters: string[][];
  il: string[];
  cats: string[];
  catValue: ((id: string) => Record<string, number> | undefined) | null;
  fpts: ((id: string) => number) | null;
  /** The standings model's power rankings (#743): the table's order and its projection columns. */
  power: PowerRank[] | null;
  /** A line under the heading, such as how to show the real standings. */
  note?: string | null;
  /** Inside another card: the table without a card of its own. */
  inline?: boolean;
}) {
  const teams = rosters
    .map((roster, t) => {
      const active = roster.filter((id) => !il.includes(id));
      const totals = Object.fromEntries(cats.map((c) => [c, active.reduce((s, id) => s + (catValue?.(id)?.[c] ?? 0), 0)]));
      const total = fpts ? active.reduce((s, id) => s + fpts(id), 0) : cats.reduce((s, c) => s + (totals[c] ?? 0), 0);
      return { team: t, size: roster.length, totals, total };
    })
    .filter((x) => x.size > 0);
  if (teams.length < 2) return null;
  const n = teams.length;
  const third = Math.max(1, Math.round(n / 3));
  const rankOf = (get: (x: (typeof teams)[number]) => number, team: number) => 1 + teams.filter((x) => get(x) > get(teams.find((y) => y.team === team)!)).length;
  const tone = (rank: number) => (n < 3 ? '' : rank <= third ? 'text-good' : rank > n - third ? 'text-bad' : '');
  const label = (c: string) => CATEGORY_LABELS[c] ?? c;
  const projected = new Map((power ?? []).map((p, i) => [p.team, { ...p, place: i + 1 }]));
  const h2h = !!power?.some((p) => p.matchupWin !== null);
  // the projection orders the table when it has every team; otherwise the totals do
  const order = (x: (typeof teams)[number]) => (projected.get(x.team)?.place ?? n + 1) * 1e6 - x.total;
  const body = (
    <>
      {note && (
        <p className="mt-1 text-sm" data-testid="standings-note">
          {note}
        </p>
      )}
      <p className="mt-1 text-xs text-muted">
        {fpts
          ? 'Each team’s projected fantasy points a game, from its active players.'
          : `${
              power
                ? h2h
                  ? 'Teams ranked by their projected matchup win rate against the rest of the league, with the categories they expect to win a week against an average rival. '
                  : 'Teams ranked by their expected rotisserie points: one per category, and one more for each team finished ahead of. '
                : ''
            }Each category is the team’s value per game above replacement, summed over its active players: green the top third, red the bottom third.`}
      </p>
      <div className="table-scroll mt-2 max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="League table">
        <table className="w-full text-sm" data-testid="team-strength">
          <thead>
            <tr>
              {power && <Th right>#</Th>}
              <Th>Team</Th>
              {power && h2h && (
                <Th right>
                  <span title="The chance of winning a weekly matchup against a team picked at random from the rest">Win %</span>
                </Th>
              )}
              {power && (
                <Th right>
                  <span title={h2h ? 'Categories expected to win a week against an average rival' : 'Expected rotisserie points'}>{h2h ? 'Cats' : 'Roto pts'}</span>
                </Th>
              )}
              <Th right>Players</Th>
              {!fpts && cats.map((c) => <Th key={c} right>{label(c)}</Th>)}
              <Th right>{fpts ? 'FPts/G' : 'Total'}</Th>
            </tr>
          </thead>
          <tbody>
            {[...teams]
              .sort((a, b) => order(a) - order(b))
              .map((x) => {
                const p = projected.get(x.team);
                return (
                  <tr key={x.team} className={`border-t border-line ${x.team === mine ? 'font-semibold' : ''}`} data-testid="power-row">
                    {power && <Td right>{p?.place ?? '–'}</Td>}
                    <Td>{names[x.team]}</Td>
                    {power && h2h && <Td right>{p?.matchupWin != null ? `${Math.round(p.matchupWin * 100)}%` : '–'}</Td>}
                    {power && <Td right>{p ? fmt(h2h ? p.expectedCats : (p.rotoPoints ?? 0), 1) : '–'}</Td>}
                    <Td right>{x.size}</Td>
                    {!fpts &&
                      cats.map((c) => {
                        const rank = rankOf((y) => y.totals[c] ?? 0, x.team);
                        return (
                          <Td key={c} right>
                            <span className={tone(rank)} title={`Rank ${rank} of ${n}`}>
                              {fmt(x.totals[c] ?? 0, 1)}
                            </span>
                          </Td>
                        );
                      })}
                    <Td right>
                      <span className={tone(rankOf((y) => y.total, x.team))}>{fmt(x.total, 1)}</span>
                    </Td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </>
  );
  if (inline) {
    return (
      <div className="mt-2" data-testid="league-table">
        {body}
      </div>
    );
  }
  return (
    <Tile title={power ? 'Power rankings' : 'League table'} id="league-table" testid="league-table" issue={power ? 867 : undefined}>
      {body}
    </Tile>
  );
}
