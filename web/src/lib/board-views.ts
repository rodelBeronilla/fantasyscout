/** The board's views, the stat lines it shows and what the value counts: the labels and help each control shows. */
import type { BoardView } from './board-url';

export const VIEWS: { id: BoardView; label: string; help: string }[] = [
  {
    id: 'value',
    label: 'Value',
    help: 'Value per game above replacement in your league, from each player’s projected line, times the share of games they are projected to play. Zero is a player you could pick up for free.',
  },
  { id: 'season', label: 'This season', help: 'Category z-scores over this season’s games.' },
  { id: 'last20', label: 'Last 20', help: 'Category z-scores over each player’s last twenty games this season.' },
  { id: 'recent', label: 'Last 10', help: 'Category z-scores over each player’s last ten games this season.' },
  {
    id: 'projected',
    label: 'Projected line',
    help: 'The per-game line the value is scored on: production per minute (seasons weighted by minutes played) times projected minutes, recent seasons counting more, starting from a replacement-level player.',
  },
  { id: 'pergame', label: 'Season line', help: 'This season’s per-game line; percentages are makes over attempts.' },
];

export const LINE: { key: string; label: string; kind: 'num' | 'pct' }[] = [
  { key: 'minutes_pg', label: 'MIN', kind: 'num' },
  { key: 'points_pg', label: 'PTS', kind: 'num' },
  { key: 'rebounds_total_pg', label: 'REB', kind: 'num' },
  { key: 'assists_pg', label: 'AST', kind: 'num' },
  { key: 'steals_pg', label: 'STL', kind: 'num' },
  { key: 'blocks_pg', label: 'BLK', kind: 'num' },
  { key: 'three_pointers_made_pg', label: '3PM', kind: 'num' },
  { key: 'field_goal_pct', label: 'FG%', kind: 'pct' },
  { key: 'free_throw_pct', label: 'FT%', kind: 'pct' },
  { key: 'turnovers_pg', label: 'TO', kind: 'num' },
];

/** The columns of a line view: this season's line, or the projection's (proj_ prefix). */
export function lineColumns(view: BoardView): { key: string; label: string; kind: 'num' | 'pct' }[] {
  return LINE.map((c) => ({ ...c, key: view === 'projected' ? `proj_${c.key}` : c.key }));
}

/** What the value counts (#714): a game, the season's games played, or the games left. */
export type Basis = 'pergame' | 'season' | 'rest';
export const BASIS_HELP: Record<Basis, string> = {
  pergame: 'Per game: what one game is worth, however often the player plays.',
  season: 'Season: per game, times the share of games the player is projected to play.',
  rest: 'Rest of season: per game, over the games left the player is expected to play.',
};
