// The Pickups page's rows and its full table (moved out of Streamers.tsx, #819).
import type { ReactNode } from 'react';

import { blowout, nextGames } from '../lib/blowout';
import type { League } from '../lib/data';
import { CATEGORY_LABELS, day, fmt, pct } from '../lib/format';
import type { SortDir } from '../lib/players';
import { href } from '../lib/site';
import { BlowoutTag, InjuryTag, injuryDetail, LineupTag, NewsTag, NewTeam, RestRiskTag, Signed, SortTh, Star, Td, Th, TopOutTag, TrendTag } from './ui';
import type { StreamerColumn, ExportedRow } from '../generated/columns';

interface StreamerRowFields {
  player_id: string;
  /** Today's role from the league's starting lineups (NBA): starter, bench or inactive. */
  lineup_role?: string | null;
  lineup_confirmed?: boolean | null;
  /** How widely ESPN leagues roster the player: most, many, some, few or rare. */
  ownership_bucket?: string | null;
  /** The team has nothing left to play for in the last stretch (fct_team_stakes). */
  rest_risk?: boolean | null;
  /** Sleeper leagues that added and dropped the player over the last day (NBA; null when not trending). */
  sleeper_adds?: number | null;
  sleeper_drops?: number | null;
  /** adding or dropping across Sleeper leagues over the last day. */
  waiver_trend?: string | null;
  /** The team's largest-usage player, when the official report has them out for the next game (#485). */
  top_teammate_out?: string | null;
  top_teammate_out_usage?: number | null;
  /** rising or falling ESPN ownership (both leagues). */
  ownership_trend?: string | null;
  /** What the team still plays for (fct_team_stakes), behind the rest-risk tag. */
  team_stakes?: string | null;
  /** Team games left this fantasy week, Monday to Sunday. */
  games_this_week?: number | null;
  news_flag?: string | null;
  news_headline?: string | null;
  news_date?: string | null;
  lineup_date?: string | null;
  injury_type?: string | null;
  expected_return?: string | null;
  injury_note?: string | null;
  injury_news?: string | null;
  injury_since?: string | null;
  injury_source?: string | null;
  official_game_date?: string | null;
  official_report_at?: string | null;
  full_name: string | null;
  position: string | null;
  team_id: string | null;
  team_abbreviation: string | null;
  season: string;
  season_complete: boolean;
  games_next_7: number;
  last_game_date: string | null;
  games_season: number | null;
  minutes_avg_5: number | null;
  minutes_trend: number | null;
  minutes_baseline: number | null;
  season_z_total: number | null;
  last_10_z_total: number | null;
  last_10_points_pg: number | null;
  last_10_rebounds_total_pg: number | null;
  last_10_assists_pg: number | null;
  last_10_steals_pg: number | null;
  last_10_blocks_pg: number | null;
  last_10_three_pointers_made_pg: number | null;
  last_10_turnovers_pg: number | null;
  last_10_fga_pg: number | null;
  last_10_fta_pg: number | null;
  last_10_fgm_pg: number | null;
  last_10_ftm_pg: number | null;
  value_trend: number | null;
  rank_total: number | null;
  is_new_team: boolean | null;
  prev_team_abbreviation: string | null;
  points_avg_5: number | null;
  rebounds_total_avg_5: number | null;
  assists_avg_5: number | null;
  steals_avg_5: number | null;
  blocks_avg_5: number | null;
  three_pointers_made_avg_5: number | null;
  field_goal_pct_5: number | null;
  free_throw_pct_5: number | null;
  turnovers_avg_5: number | null;
  injury_status: string | null;
  injury_group: string | null;
  [key: string]: unknown;
}
// Only columns the export ships (export/layout.py): a field it does not ship fails the type check (#479).
export type StreamerRow = ExportedRow<StreamerColumn, StreamerRowFields>;

/** A streamer row with what the page works out from the schedule and the picked needs. */
export interface Candidate extends StreamerRow {
  games_window: number;
  games_picked: number;
  fit: number | null;
  /** Average matchup over the window's games: value per game the opponents' defence and pace add. */
  matchup: number | null;
  /** Points the betting lines imply the team scores, averaged over the window's games with a line. */
  implied_points: number | null;
  /** Last-ten value per game over the window's games, plus each game's matchup. */
  window_value: number | null;
  /** Sleeper leagues that added the player minus those that dropped the player, over the last day. */
  sleeper_net: number | null;
  /** Last-ten value over the league's categories: an 8-category league leaves out turnovers. */
  value_10: number | null;
  /** What an average game of the last ten adds to the week's category totals (8 categories: no turnovers). */
  production_10: number | null;
}

/** A count of Sleeper leagues, short: 26,552 as 26.6k. */
function leagues(n: number): string {
  const a = Math.abs(n);
  return a >= 1000 ? `${(a / 1000).toFixed(1)}k` : String(a);
}

/** Net adds across Sleeper leagues over the last day, coloured by direction, with both counts in the tooltip. */
function WaiverHeat({ row }: { row: Candidate }) {
  if (row.sleeper_net === null) return <span className="text-muted">–</span>;
  const n = row.sleeper_net;
  const cls = n > 0 ? 'text-good' : n < 0 ? 'text-bad' : '';
  const title = `${(row.sleeper_adds ?? 0).toLocaleString()} Sleeper leagues added the player and ${(row.sleeper_drops ?? 0).toLocaleString()} dropped the player in the last day`;
  return (
    <span className={cls} title={title} data-testid="waiver-heat">
      {n > 0 ? '+' : n < 0 ? '−' : ''}
      {leagues(n)}
    </span>
  );
}

export interface TableProps {
  rows: Candidate[];
  league: League;
  nextByTeam: ReturnType<typeof nextGames>;
  sortKey: string;
  sortDir: SortDir;
  sortBy: (key: string, dir?: SortDir) => void;
  inWeek: boolean;
  moreCols: boolean;
  /** The header of the window's games column: "Period" or "Next 7". */
  gamesLabel: string;
  gamesTitle: string;
  points: boolean;
  /** The categories the value leaves out: the punts, and turnovers in an 8-category league. */
  dropped: string[];
  needs: number;
  openDays: number;
  hasTrend: boolean;
  hasHeat: boolean;
  watched: Set<string>;
  toggleWatched: (id: string) => void;
}

export function PickupsTable(p: TableProps) {
  const { rows, league, sortKey, sortDir, inWeek, moreCols, points, dropped } = p;
  const col = (key: string, label: string, title?: string): ReactNode => (
    <SortTh right active={sortKey === key} dir={sortDir} onClick={() => p.sortBy(key)} title={title}>
      {label}
    </SortTh>
  );
  return (
    <div className="table-scroll max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="Streamer candidates">
      <table className="w-full text-sm" data-testid="trending">
        <thead>
          <tr>
            <SortTh active={sortKey === 'name'} dir={sortDir} onClick={() => p.sortBy('name', 'asc')} pin="first" title="The player, with injury, lineup and news tags">
              Player
            </SortTh>
            {inWeek && col('window_value', 'Window value', 'What the player adds to the window: last-ten production per game (counting stats and shooting above the pool, turnovers subtracted) times games in the window, plus each game’s matchup. The default sort: it finds the week’s best pickups most often (streamer signals notebook)')}
            {inWeek && col('games_window', p.gamesLabel, p.gamesTitle)}
            {inWeek && col('matchup', 'Matchup', 'Average value per game the opponents add or take away in this window: their defence and the expected pace (small: about 0.2 for one standard deviation of defence)')}
            {inWeek && moreCols && col('implied_points', 'Team pts', 'Points the betting lines imply the team scores, per game in the window that has a line: a high-scoring game means more counting stats')}
            {moreCols && col('games_season', 'GP', 'Games played this season: a short sample makes the trends below less sure (#463)')}
            {moreCols && col('minutes_avg_5', 'Min (5)', 'Minutes per game, last five games')}
            {moreCols && col('minutes_baseline', 'Min (base)', 'Minutes per game before the last five games, blended with last season')}
            {col('minutes_trend', 'Min trend', 'Last five games minus the baseline')}
            {(moreCols || !inWeek) && col(
              'value_10',
              points ? 'FPts (10)' : 'Value (10)',
              points
                ? "Fantasy points per game over the last ten games, scored with your league's weights"
                : dropped.length
                  ? `Total category z-score over the last ten games, leaving out ${dropped.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}`
                  : 'Total category z-score over the last ten games',
            )}
            {col('value_trend', 'Value trend', 'Last-ten value minus the baseline (this season blended with last)')}
            {/* The box-score columns are the last five games, like Min (5) (#456); behind More columns (#722). */}
            {moreCols && col('points_avg_5', 'PTS (5)', 'Points per game, last five games')}
            {moreCols && col('rebounds_total_avg_5', 'REB (5)', 'Rebounds per game, last five games')}
            {moreCols && col('assists_avg_5', 'AST (5)', 'Assists per game, last five games')}
            {moreCols && col('steals_avg_5', 'STL (5)', 'Steals per game, last five games')}
            {moreCols && col('blocks_avg_5', 'BLK (5)', 'Blocks per game, last five games')}
            {moreCols && col('three_pointers_made_avg_5', '3PM (5)', 'Three-pointers made per game, last five games')}
            {moreCols && col('field_goal_pct_5', 'FG% (5)', 'Field-goal percentage over the last five games')}
            {moreCols && col('free_throw_pct_5', 'FT% (5)', 'Free-throw percentage over the last five games')}
            {moreCols && col('turnovers_avg_5', 'TO (5)', 'Turnovers per game, last five games')}
            {p.needs > 0 && col('fit', 'Need fit', 'Last-ten z-score summed over the categories you need')}
            {p.openDays > 0 && col('games_picked', 'Open days', 'Games on the days you have open')}
            {p.hasTrend && (
              <Th right>
                <span title="Rising or falling across ESPN leagues (ownership up or down a point or more)">ESPN</span>
              </Th>
            )}
            {p.hasHeat && col('sleeper_net', 'Sleeper', 'Sleeper leagues that added the player minus those that dropped the player, last 24 hours (from Sleeper)')}
            {moreCols && col('rank_total', 'Board #', 'Rank on the board with the default league settings (12 teams of 13 in the NBA, 10 of 10 in the WNBA); inside a league-sized pool usually means rostered')}
            {moreCols && (
              <Th>
                <span title="The date of the player's most recent game">Last game</span>
              </Th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.player_id} className="border-t border-line">
              <td className="pin max-w-[11rem] px-2 py-1.5 sm:max-w-none">
                <span className="flex flex-wrap items-center gap-1 sm:flex-nowrap">
                  <Star on={p.watched.has(r.player_id)} label={r.full_name ?? r.player_id} onToggle={() => p.toggleWatched(r.player_id)} />
                  <a href={href(`/p/${league}/${r.player_id}/`)} className="whitespace-nowrap underline-offset-4 hover:underline">
                    {r.full_name ?? r.player_id}
                  </a>
                  {r.is_new_team && <NewTeam from={r.prev_team_abbreviation} />}
                  <LineupTag role={r.lineup_role} confirmed={r.lineup_confirmed} date={r.lineup_date} injuryGroup={r.injury_group} />
                  <RestRiskTag risk={r.rest_risk} stakes={r.team_stakes} />
                  <BlowoutTag risk={blowout(league, r.lineup_role, r.team_id ? p.nextByTeam.get(r.team_id) : undefined)} />
                  <TopOutTag name={r.top_teammate_out} usage={r.top_teammate_out_usage} />
                  <NewsTag flag={r.news_flag} headline={r.news_headline} date={r.news_date} />
                  <InjuryTag group={r.injury_group} status={r.injury_status} detail={injuryDetail(r)} />
                </span>
                {/* team and position under the name, as on the board (#722) */}
                <span className="block text-[11px] text-muted" data-testid="team-pos">
                  {r.position ?? '–'} · {r.team_abbreviation ?? '–'}
                </span>
              </td>
              {inWeek && <Td right>{fmt(r.window_value, 2)}</Td>}
              {inWeek && <Td right>{r.games_window}</Td>}
              {inWeek && (
                <Td right>
                  <Signed value={r.matchup} />
                </Td>
              )}
              {inWeek && moreCols && <Td right>{fmt(r.implied_points, 1)}</Td>}
              {moreCols && <Td right>{r.games_season ?? '–'}</Td>}
              {moreCols && <Td right>{fmt(r.minutes_avg_5)}</Td>}
              {moreCols && <Td right>{fmt(r.minutes_baseline)}</Td>}
              <Td right>
                <Signed value={r.minutes_trend} digits={1} />
              </Td>
              {(moreCols || !inWeek) && <Td right>{fmt(r.value_10, 2)}</Td>}
              <Td right>
                <Signed value={r.value_trend} />
              </Td>
              {moreCols && <Td right>{fmt(r.points_avg_5)}</Td>}
              {moreCols && <Td right>{fmt(r.rebounds_total_avg_5)}</Td>}
              {moreCols && <Td right>{fmt(r.assists_avg_5)}</Td>}
              {moreCols && <Td right>{fmt(r.steals_avg_5)}</Td>}
              {moreCols && <Td right>{fmt(r.blocks_avg_5)}</Td>}
              {moreCols && <Td right>{fmt(r.three_pointers_made_avg_5)}</Td>}
              {moreCols && <Td right>{pct(r.field_goal_pct_5)}</Td>}
              {moreCols && <Td right>{pct(r.free_throw_pct_5)}</Td>}
              {moreCols && <Td right>{fmt(r.turnovers_avg_5)}</Td>}
              {p.needs > 0 && (
                <Td right>
                  <Signed value={r.fit} />
                </Td>
              )}
              {p.openDays > 0 && (
                <Td right>
                  {r.games_picked}/{p.openDays}
                </Td>
              )}
              {p.hasTrend && (
                <Td right>
                  <TrendTag trend={r.ownership_trend} />
                </Td>
              )}
              {p.hasHeat && (
                <Td right>
                  <WaiverHeat row={r} />
                </Td>
              )}
              {moreCols && <Td right>{r.rank_total ?? '–'}</Td>}
              {moreCols && <Td>{day(r.last_game_date)}</Td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
