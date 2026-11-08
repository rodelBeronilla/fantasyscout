/** The board's header row: each column sorts the board, and its tooltip says what it counts. */
import type { BoardView } from '../lib/board-url';
import { isLine } from '../lib/board-model';
import { type Basis, BASIS_HELP } from '../lib/board-views';
import type { SortDir } from '../lib/players';
import { SortTh, Th } from './ui';

/** A column of figures: a stat, a category's value or fantasy points. */
export type CategoryColumn = { key: string; label: string; kind: 'num' | 'pct' | 'z' | 'fpts'; category?: string };

export function BoardHead({
  sortKey,
  sortDir,
  sortBy,
  view,
  basis,
  showMarket,
  showFit,
  byStandings,
  categoryColumns,
  scheduleCols,
  showNext7,
  rangeCols,
}: {
  sortKey: string;
  sortDir: SortDir;
  sortBy: (key: string, defaultDir?: SortDir) => void;
  view: BoardView;
  basis: Basis;
  showMarket: boolean;
  showFit: boolean;
  /** Fit is weighted by the standings, rather than by where the team is weak. */
  byStandings: boolean;
  categoryColumns: CategoryColumn[];
  scheduleCols: boolean;
  showNext7: boolean;
  rangeCols: boolean;
}) {
  return (
    <thead className="bg-card">
      <tr>
        <Th right pin="first">#</Th>
        <SortTh active={sortKey === 'name'} dir={sortDir} onClick={() => sortBy('name', 'asc')} pin="second">
          Player
        </SortTh>
        {!isLine(view) && (
          <SortTh right active={sortKey === 'value'} dir={sortDir} onClick={() => sortBy('value')} title={BASIS_HELP[basis]}>
            Value
          </SortTh>
        )}
        {showMarket && (
          <SortTh
            right
            active={sortKey === 'market_rank'}
            dir={sortDir}
            onClick={() => sortBy('market_rank', 'asc')}
            title="Where ESPN fantasy drafters take the player (by average draft position); the tooltip says how widely ESPN leagues roster the player"
          >
            Mkt
          </SortTh>
        )}
        {showMarket && (
          <SortTh
            right
            active={sortKey === 'market_gap'}
            dir={sortDir}
            onClick={() => sortBy('market_gap')}
            title="Market rank minus the player's rank on this board with your league's settings: positive when drafters take the player later than the value here (a bargain), negative when they reach"
          >
            vs Mkt
          </SortTh>
        )}
        {showFit && (
          <SortTh
            right
            active={sortKey === 'fit'}
            dir={sortDir}
            onClick={() => sortBy('fit')}
            title={
              byStandings
                ? "Value with each category weighted by how much a gain there raises your chance of beating the league's other teams in it: close categories count most, ones won or lost against everyone by a wide margin least"
                : 'Value with each category weighted by where your team is weak (1.5 for the weakest third, 1 the middle, 0.5 the strongest)'
            }
          >
            Fit
          </SortTh>
        )}
        {categoryColumns.map((c) => (
          <SortTh key={c.key} right active={sortKey === c.key} dir={sortDir} onClick={() => sortBy(c.key, c.label === 'TO' && c.kind !== 'z' ? 'asc' : 'desc')}>
            <span data-cat={c.category}>{c.label}</span>
          </SortTh>
        ))}
        {scheduleCols && (
          <SortTh right active={sortKey === 'age'} dir={sortDir} onClick={() => sortBy('age', 'asc')}>
            Age
          </SortTh>
        )}
        {scheduleCols && (
          <SortTh right active={sortKey === 'games_current'} dir={sortDir} onClick={() => sortBy('games_current')} title="Games this season">
            GP
          </SortTh>
        )}
        {scheduleCols && view === 'value' && (
          <SortTh right active={sortKey === 'games_share'} dir={sortDir} onClick={() => sortBy('games_share')} title="Projected share of team games played">
            GP%
          </SortTh>
        )}
        {scheduleCols && showNext7 && (
          <SortTh right active={sortKey === 'games_next_7'} dir={sortDir} onClick={() => sortBy('games_next_7')} title="Team games in the next 7 days">
            Next 7
          </SortTh>
        )}
        {scheduleCols && showNext7 && (
          <SortTh right active={sortKey === 'games_this_week'} dir={sortDir} onClick={() => sortBy('games_this_week')} title="Team games left this fantasy week (Monday to Sunday)">
            Wk
          </SortTh>
        )}
        {rangeCols && (
          <SortTh right active={sortKey === 'game_floor'} dir={sortDir} onClick={() => sortBy('game_floor')} title="A bad game: the player's 20th-percentile game this season, on the value scale, above replacement level">
            Floor
          </SortTh>
        )}
        {rangeCols && (
          <SortTh right active={sortKey === 'game_ceiling'} dir={sortDir} onClick={() => sortBy('game_ceiling')} title="A good game: the player's 80th-percentile game this season, on the value scale, above replacement level">
            Ceiling
          </SortTh>
        )}
        {rangeCols && (
          <SortTh right active={sortKey === 'game_value_sd'} dir={sortDir} onClick={() => sortBy('game_value_sd', 'asc')} title="How much one game differs from the next (standard deviation): low is steady, high is boom or bust">
            Spread
          </SortTh>
        )}
        <Th>Cmp</Th>
      </tr>
    </thead>
  );
}
