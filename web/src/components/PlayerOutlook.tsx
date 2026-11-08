/** The player page's outlook: what the board projects for the player, and where they stand in the manager's league. */
import type { ReactNode } from 'react';

import type { League } from '../lib/data';
import { fmt, nextSeason, pct } from '../lib/format';
import type { PlayerFile } from '../lib/player-file';
import { href } from '../lib/site';
import { assign, owners, useLeague } from '../lib/fantasy-league';
import { Card, Signed, Unvalidated } from './ui';

const OWNED: Record<string, string> = {
  most: '70% or more',
  many: '40 to 70%',
  some: '10 to 40%',
  few: '1 to 10%',
  rare: 'under 1%',
};

const STAKES: Record<string, string> = {
  clinched: 'Clinched a playoff place',
  eliminated: 'Eliminated',
  racing: 'Still racing for a place',
};

/** One labelled figure in the outlook. */
function Fact({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-1.5" title={hint}>
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/** What the board projects for the player and the context it shows beside the value. */
export function OutlookCard({ board, league, season, status }: { board: NonNullable<PlayerFile['board']>; league: League; season: string | null; status: ReactNode }) {
  const line: [string, string][] = [
    ['MIN', fmt(board.proj_minutes_pg)],
    ['PTS', fmt(board.proj_points_pg)],
    ['REB', fmt(board.proj_rebounds_total_pg)],
    ['AST', fmt(board.proj_assists_pg)],
    ['STL', fmt(board.proj_steals_pg)],
    ['BLK', fmt(board.proj_blocks_pg)],
    ['3PM', fmt(board.proj_three_pointers_made_pg)],
    ['TO', fmt(board.proj_turnovers_pg)],
    ['FG%', pct(board.proj_field_goal_pct)],
    ['FT%', pct(board.proj_free_throw_pct)],
  ];
  const today =
    board.lineup_role === 'starter' ? 'Starting' : board.lineup_role === 'inactive' ? 'Inactive' : 'Bench';
  return (
    <Card title="Fantasy outlook" id="outlook" badge={<Unvalidated issue={754} what="The projection" />}>
      {status}
      {/* After the last game the week, the stakes and the ownership no longer apply (#450). */}
      {board.season_complete && season && (
        <p className="mb-3 text-sm text-muted" data-testid="season-over">
          {season} season over · {nextSeason(season) ? `${nextSeason(season)} projection` : 'the projection for next season'}
        </p>
      )}
      <div className="grid gap-x-8 gap-y-4 md:grid-cols-2" data-testid="player-outlook">
        <dl className="text-sm">
          <Fact label="Board rank (default league)" value={`#${board.rank_total}`} />
          <Fact
            label="Value per game"
            value={<Signed value={board.value_per_game} />}
            hint="Category value per game above replacement, summed over the nine categories"
          />
          <Fact
            label="Season value"
            value={<Signed value={board.value_total} />}
            hint="Value per game times the projected share of regular-season games"
          />
          {!board.season_complete && (
            <Fact
              label="Rest of season"
              value={<Signed value={board.value_rest_of_season} />}
              hint="Value over the games left, scaled by availability"
            />
          )}
          <Fact label="Projected games share" value={pct(board.games_share)} hint="Share of regular-season games the player is projected to play" />
          {typeof board.game_floor === 'number' && typeof board.game_ceiling === 'number' && (
            <Fact
              label="Game range"
              value={
                <span data-testid="game-range">
                  <Signed value={board.game_floor} digits={1} /> to <Signed value={board.game_ceiling} digits={1} />
                </span>
              }
              hint="A bad game to a good one this season (the 20th to the 80th percentile), on the nine-category z-score scale; a narrow range is a steady player"
            />
          )}
          {typeof board.availability_multiplier === 'number' && board.availability_multiplier < 1 && (
            <Fact
              label="Available for"
              value={pct(board.availability_multiplier)}
              hint="Share of the remaining regular-season games the player is expected to play"
            />
          )}
          {typeof board.expected_games_missed === 'number' && !board.expected_return && (
            <Fact
              label="Expected to miss"
              value={`${fmt(board.expected_games_missed)} games`}
              hint="Players listed with this status went on to miss this many games on average (official injury reports since 2023-24)"
            />
          )}
          {!board.season_complete && <Fact label="Games next 7 days" value={board.games_next_7 ?? '–'} />}
          {!board.season_complete && <Fact label="Games left" value={board.games_remaining ?? '–'} />}
        </dl>
        <dl className="text-sm">
          {board.lineup_role && (
            <Fact
              label="Next game day"
              value={`${today}${board.lineup_confirmed ? ' (confirmed)' : ' (expected)'}`}
              hint="From the league's starting lineups for the next game day"
            />
          )}
          {board.market_rank != null && (
            <Fact label="ESPN market rank" value={`#${board.market_rank}`} hint="Where ESPN fantasy drafters take the player, by average draft position" />
          )}
          {!board.season_complete && board.ownership_bucket && (
            <Fact label="Rostered in" value={`${OWNED[board.ownership_bucket] ?? board.ownership_bucket} of ESPN leagues`} />
          )}
          {!board.season_complete && board.team_stakes && <Fact label="Team" value={STAKES[board.team_stakes] ?? board.team_stakes} />}
          {!board.season_complete && board.rest_risk && (
            <Fact label="Rest risk" value="Nothing left to play for" hint="Few games left and nothing to play for: minutes are less certain" />
          )}
        </dl>
      </div>
      <div className="mt-4">
        <p className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Projected per game</p>
        <dl className="grid grid-cols-5 gap-2 text-center text-sm sm:grid-cols-10" data-testid="projected-line">
          {line.map(([k, v]) => (
            <div key={k} className="rounded border border-line px-1 py-1.5">
              <dt className="text-[11px] text-muted">{k}</dt>
              <dd className="font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="mt-3 text-xs text-muted">
        Values are for the default league ({league === 'nba' ? '12 teams of 13' : '10 teams of 10'}); the Board re-scores
        them for your league&apos;s settings.
      </p>
    </Card>
  );
}

/**
 * Where the player stands in the manager's league (#726): on their team, free, or on another team,
 * with the next step from here: offer them in a trade, add them, or trade for them.
 */
export function LeagueStatus({ league, playerId, name }: { league: League; playerId: string; name: string }) {
  const [setup, update] = useLeague(league);
  const owner = owners(setup);
  const t = owner.get(playerId);
  const link = 'rounded border border-accent px-2 py-0.5 text-sm font-medium text-accent hover:bg-accent hover:text-accent-fg';
  const q = (side: 'give' | 'get') => href(`/trade/?league=${league}&${side}=${playerId}`);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-bg px-3 py-2 text-sm" data-testid="league-status">
      {owner.size === 0 ? (
        <span className="text-muted">
          <a href={href('/league/')} className="underline underline-offset-4">
            Set up your league
          </a>{' '}
          to see whether {name} is free, and what to do about it.
        </span>
      ) : t === setup.mine ? (
        <>
          <strong className="text-good">On your team</strong>
          <a href={q('give')} className={link}>
            Offer in a trade
          </a>
          <a href={href('/team/')} className="underline-offset-4 hover:underline">
            My Team →
          </a>
        </>
      ) : t === undefined ? (
        <>
          <strong>Available in your league</strong>
          <button
            type="button"
            className={link}
            onClick={() => update((s) => assign(s, playerId, s.mine))}
            title="Records the pickup in the league kept here; make it in your league's app too"
          >
            Add to {setup.names[setup.mine]}
          </button>
          <a href={href('/streamers/')} className="underline-offset-4 hover:underline">
            Compare on Pickups →
          </a>
        </>
      ) : (
        <>
          <strong>On {setup.names[t]}</strong>
          <a href={q('get')} className={link}>
            Trade for {name}
          </a>
        </>
      )}
    </div>
  );
}
