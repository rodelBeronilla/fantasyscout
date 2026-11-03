import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { fetchBuildJson, type League } from '../lib/data';
import { CATEGORIES, CATEGORY_LABELS, day, fmt, lineSource, nextSeason, pct } from '../lib/format';
import { isLeague } from '../lib/league';
import { type CrewFields, crewText } from '../lib/referees';
import { href } from '../lib/site';
import { assign, owners, useLeague } from '../lib/fantasy-league';
import ShotChart from './ShotChart';
import TrendChart from './TrendChart';
import { Badge, Card, Loading, Problem, Signed, Td, Th } from './ui';
import type { ExportedRow, PlayerBoardColumn, PlayerRollingColumn, PlayerZscoreColumn } from '../generated/columns';

interface Season {
  season: string;
  games: number;
  games_played: number;
  minutes_pg: number | null;
  points_pg: number | null;
  rebounds_total_pg: number | null;
  assists_pg: number | null;
  steals_pg: number | null;
  blocks_pg: number | null;
  turnovers_pg: number | null;
  three_pointers_made_pg: number | null;
  field_goal_pct: number | null;
  free_throw_pct: number | null;
  agree_exact: number;
  agree_minor: number;
  agree_conflict: number;
  agree_unverified: number;
}

interface Game {
  season: string;
  game_id: string;
  game_date: string;
  is_home: boolean;
  opponent: string | null;
  played: boolean;
  comment: string | null;
  minutes: number | null;
  points: number | null;
  rebounds_total: number | null;
  assists: number | null;
  steals: number | null;
  blocks: number | null;
  turnovers: number | null;
  field_goals_made: number | null;
  field_goals_attempted: number | null;
  three_pointers_made: number | null;
  three_pointers_attempted: number | null;
  free_throws_made: number | null;
  free_throws_attempted: number | null;
  plus_minus: number | null;
  source_agreement: string;
}

interface ZscoreFields {
  window_name: string;
  season: string;
  games: number;
  z_total: number | null;
  [key: string]: unknown;
}
// The player file's sections name only columns the export ships (export/layout.py, #479).
type Zscore = ExportedRow<PlayerZscoreColumn, ZscoreFields>;
type Rolling = ExportedRow<PlayerRollingColumn, { game_number: number; game_date: string; [key: string]: unknown }>;

/** The z-score windows the player file carries, in the order the page lists them. */
const WINDOWS = ['season', 'last_20', 'last_10'] as const;
const WINDOW_LABEL: Record<string, string> = { season: 'Season', last_20: 'Last 20', last_10: 'Last 10' };

interface PlayerBoardFields {
  rank_total: number;
  value_total: number | null;
  value_rest_of_season: number | null;
  value_per_game?: number | null;
  games_share?: number | null;
  availability_multiplier?: number | null;
  expected_games_missed?: number | null;
  games_remaining?: number | null;
  games_next_7?: number | null;
  season_complete?: boolean | null;
  proj_minutes_pg?: number | null;
  proj_points_pg?: number | null;
  proj_rebounds_total_pg?: number | null;
  proj_assists_pg?: number | null;
  proj_steals_pg?: number | null;
  proj_blocks_pg?: number | null;
  proj_three_pointers_made_pg?: number | null;
  proj_turnovers_pg?: number | null;
  proj_field_goal_pct?: number | null;
  proj_free_throw_pct?: number | null;
  lineup_role?: string | null;
  lineup_confirmed?: boolean | null;
  market_rank?: number | null;
  ownership_bucket?: string | null;
  team_stakes?: string | null;
  rest_risk?: boolean | null;
  injury_status?: string | null;
  injury_group?: string | null;
  injury_type?: string | null;
  expected_return?: string | null;
  injury_note?: string | null;
  injury_news?: string | null;
  injury_since?: string | null;
  /** official (the league's report for the next game) or espn. */
  injury_source?: string | null;
  official_game_date?: string | null;
}
type PlayerBoard = ExportedRow<PlayerBoardColumn, PlayerBoardFields>;

interface PlayerFile {
  league: League;
  player_id: string;
  espn_player_id: string | null;
  name: string | null;
  position: string | null;
  height: string | null;
  weight_lbs: number | null;
  birth_date: string | null;
  school: string | null;
  team: { team_id: string | null; abbreviation: string | null; name: string | null };
  last_game_date: string | null;
  current_season: string | null;
  stints: { team_id: string; abbreviation: string | null; valid_from: string; valid_to: string | null }[];
  seasons: Season[];
  game_log: Game[];
  rolling: Rolling[];
  zscores: Zscore[];
  board: PlayerBoard | null;
  /** The player's signings, waivers and trades from the league's feed, newest first (NBA). */
  moves?: { transaction_date: string; team_abbreviation: string | null; move_type: string; description: string }[];
  /** ESPN's newest headlines about the player: the headline, its date and a link to ESPN (absent in older builds). */
  news?: { published_date: string; headline: string; url: string; news_flag: string | null }[];
  /** Each status the player's injury listings have held, newest first (absent in older builds). */
  injury_history?: { injury_id: string; status: string; status_group: string; status_from: string; status_to: string; reports: number }[];
  shots: [number, number, number, number][];
  shot_zones: { zone: string; attempts: number; made: number; pct: number | null; league_pct: number | null }[];
}

/** A game on the published schedule ahead (mart_schedule_upcoming). */
interface Upcoming extends CrewFields {
  game_id: string;
  game_date: string;
  game_type: string;
  home_team_id: string;
  home_team_tricode: string;
  away_team_id: string;
  away_team_tricode: string;
  home_spread?: number | null;
  over_under?: number | null;
  home_implied_points?: number | null;
  away_implied_points?: number | null;
  line_provider?: string | null;
  line_as_of?: string | null;
  home_back_to_back?: boolean | null;
  away_back_to_back?: boolean | null;
}

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
function OutlookCard({ board, league, season, status }: { board: NonNullable<PlayerFile['board']>; league: League; season: string | null; status: ReactNode }) {
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
    <Card title="Fantasy outlook" id="outlook">
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
function LeagueStatus({ league, playerId, name }: { league: League; playerId: string; name: string }) {
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

/** The team's next games: opponent, the line's implied points, and the second night of a back-to-back. */
function NextGames({ games, teamId }: { games: Upcoming[]; teamId: string }) {
  const next = games.filter((g) => g.home_team_id === teamId || g.away_team_id === teamId).slice(0, 7);
  if (!next.length) return null;
  return (
    <Card title="Next games" id="next-games">
      <div className="table-scroll overflow-auto" tabIndex={0} role="region" aria-label="Next games">
        <table className="w-full text-sm" data-testid="next-games">
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Opponent</Th>
              <Th right>Team pts</Th>
              <Th>Note</Th>
            </tr>
          </thead>
          <tbody>
            {next.map((g) => {
              const home = g.home_team_id === teamId;
              const implied = home ? g.home_implied_points : g.away_implied_points;
              const b2b = home ? g.home_back_to_back : g.away_back_to_back;
              const note = [b2b ? 'Back-to-back' : null, g.game_type !== 'regular' ? g.game_type.replace('_', ' ') : null, crewText(g)]
                .filter(Boolean)
                .join(' · ');
              return (
                <tr key={g.game_id} className="border-t border-line">
                  <Td>{day(g.game_date)}</Td>
                  <Td>{home ? `vs ${g.away_team_tricode}` : `at ${g.home_team_tricode}`}</Td>
                  <Td right>
                    {typeof implied === 'number' ? (
                      <span title={`Points the betting line implies${lineSource(g.line_provider, g.line_as_of) ? ` (${lineSource(g.line_provider, g.line_as_of)})` : ''}`} data-testid="implied">
                        {fmt(implied)}
                      </span>
                    ) : (
                      '–'
                    )}
                  </Td>
                  <Td>{note}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        Team pts: the points the betting line implies the team scores, where a line is posted. The referee crew shows once the
        league posts it, on the day; its tendency is context only, not in the value.
      </p>
    </Card>
  );
}

/** What a headline's wording says, and how loudly to show it. */
const NEWS_FLAGS: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'muted' }> = {
  out_for_season: { label: 'Out for season', tone: 'bad' },
  surgery: { label: 'Surgery', tone: 'bad' },
  injury: { label: 'Injury', tone: 'warn' },
  minutes_limit: { label: 'Minutes limit', tone: 'warn' },
  return: { label: 'Return', tone: 'good' },
  g_league: { label: 'G League', tone: 'muted' },
  role: { label: 'Role', tone: 'muted' },
};

/** ESPN's headlines about the player, newest first: each links to the story on ESPN. */
function NewsCard({ news }: { news: NonNullable<PlayerFile['news']> }) {
  return (
    <Card title="In the news" id="news">
      <ul className="grid gap-1.5 text-sm" data-testid="player-news">
        {news.map((n) => {
          const flag = n.news_flag ? NEWS_FLAGS[n.news_flag] : undefined;
          return (
            <li key={n.url} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-xs text-muted">{day(n.published_date)}</span>
              {flag && <Badge tone={flag.tone}>{flag.label}</Badge>}
              <a href={n.url} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">
                {n.headline}
              </a>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-muted">Headlines and links from ESPN; the stories are on ESPN.</p>
    </Card>
  );
}

/** The player's current injury: status, since when, expected return, ESPN's news, and how the status got here. */
function InjuryCard({
  board,
  history,
}: {
  board: NonNullable<PlayerFile['board']>;
  history: NonNullable<PlayerFile['injury_history']>;
}) {
  const tone = board.injury_group === 'out' ? 'bad' : 'warn';
  // ESPN's note is sometimes the status again ("out"); a line that says nothing new is left out (#460).
  const raw = (board.injury_news || board.injury_note || '').trim();
  const note = raw && raw.toLowerCase() !== (board.injury_status ?? '').trim().toLowerCase() ? raw : null;
  return (
    <Card title="Injury" id="injury">
      <div className="grid gap-2 text-sm" data-testid="injury-card">
        <p className="flex flex-wrap items-center gap-2">
          <Badge tone={tone}>{board.injury_status ?? 'Injured'}</Badge>
          {board.injury_type && <span>{board.injury_type}</span>}
          {board.injury_since && <span className="text-muted">since {day(board.injury_since)}</span>}
          {board.expected_return && (
            <span className="text-muted" data-testid="expected-return">
              · expected back {board.season_complete ? `next season (${day(board.expected_return)})` : day(board.expected_return)}
            </span>
          )}
        </p>
        {note && <p data-testid="injury-news">{note}</p>}
        {history.length > 1 && (
          <ol className="grid gap-0.5 text-xs text-muted" data-testid="injury-history">
            {history.map((h) => (
              <li key={`${h.injury_id}-${h.status_from}`}>
                {h.status}: {day(h.status_from)}
                {h.status_to !== h.status_from ? ` to ${day(h.status_to)}` : ''}
              </li>
            ))}
          </ol>
        )}
        <p className="text-xs text-muted">
          {board.injury_source === 'official' && board.official_game_date
            ? `From the league's official injury report for ${day(board.official_game_date)}; the history is ESPN's daily listing.`
            : "From ESPN's daily injury listing."}
        </p>
      </div>
    </Card>
  );
}

function parsePath(): { league: League; playerId: string } | null {
  const m = /^\/p\/(wnba|nba)\/([^/]+)\/?$/.exec(window.location.pathname);
  if (!m || !isLeague(m[1])) return null;
  return { league: m[1], playerId: decodeURIComponent(m[2] ?? '') };
}


export default function PlayerPage() {
  const [target] = useState(() => (typeof window === 'undefined' ? null : parsePath()));
  const [player, setPlayer] = useState<PlayerFile | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [season, setSeason] = useState<string>('');

  useEffect(() => {
    if (!target) return;
    let live = true;
    fetchBuildJson<PlayerFile>(`players/${target.league}/${target.playerId}.json`)
      .then((p) => {
        if (!live) return;
        setPlayer(p);
        setSeason(p.current_season ?? p.seasons.at(-1)?.season ?? '');
        document.title = `${p.name ?? p.player_id} · FantasyScout`;
      })
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, [target]);

  // The schedule ahead, for the team's next games.
  const [schedule, setSchedule] = useState<Upcoming[]>([]);
  useEffect(() => {
    if (!target) return;
    let live = true;
    fetchBuildJson<Upcoming[]>(`schedule/${target.league}.json`)
      .then((g) => {
        if (live) setSchedule(g);
      })
      .catch(() => {
        if (live) setSchedule([]);
      });
    return () => {
      live = false;
    };
  }, [target]);

  const seasonLog = useMemo(() => (player?.game_log ?? []).filter((g) => g.season === season).slice().reverse(), [player, season]);
  const seasonZ = useMemo(() => (player?.zscores ?? []).filter((z) => z.season === player?.current_season), [player]);

  if (!target) {
    return (
      <Problem error={new Error('The address should look like /p/wnba/1629476/. Pick a player from the board.')} />
    );
  }
  if (error) return <Problem error={error} />;
  if (!player) return <Loading what="the player" />;

  const seasons = player.seasons.map((s) => s.season);
  const strengths = seasonZ.find((z) => z.window_name === 'season');
  // The season's z-scores beside the last twenty and last ten games' (#463): a recent row above
  // the season one is a player on the rise.
  const windows = WINDOWS.map((w) => seasonZ.find((z) => z.window_name === w)).filter((z): z is Zscore => !!z);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <header>
        <p className="text-sm font-medium tracking-wide text-accent uppercase">
          {target.league.toUpperCase()} · {player.team.abbreviation ?? '–'} {player.team.name ?? ''}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight" data-testid="player-name">
          {player.name ?? player.player_id}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {[player.position, player.height, player.weight_lbs ? `${player.weight_lbs} lb` : null, player.school]
            .filter(Boolean)
            .join(' · ')}
          {player.board ? ` · Board rank #${player.board.rank_total} (default league)` : ''}
          {player.last_game_date ? ` · Last game ${day(player.last_game_date)}` : ''}
        </p>
      </header>

      {player.board && (
        <OutlookCard
          board={player.board}
          league={target.league}
          season={player.current_season}
          status={<LeagueStatus league={target.league} playerId={player.player_id} name={player.name ?? 'this player'} />}
        />
      )}

      <Card title="Category strengths and drags (season z-scores)" id="categories">
        {strengths ? (
          <ul className="grid grid-cols-3 gap-2 text-sm sm:grid-cols-5 lg:grid-cols-9" data-testid="categories">
            {CATEGORIES.map((c) => (
              <li key={c} className="rounded border border-line p-2 text-center">
                <div className="text-xs text-muted">{CATEGORY_LABELS[c]}</div>
                <div className="font-medium">
                  <Signed value={strengths[c] as number | null} />
                </div>
              </li>
            ))}
            <li className="rounded border border-accent p-2 text-center">
              <div className="text-xs text-muted">Total</div>
              <div className="font-medium">
                <Signed value={strengths.z_total} />
              </div>
            </li>
          </ul>
        ) : (
          <p className="text-sm text-muted">Not in this season's player pool yet.</p>
        )}
        {windows.length > 1 && (
          <div className="table-scroll mt-3 overflow-auto" tabIndex={0} role="region" aria-label="Category z-scores by window">
            <table className="w-full text-sm" data-testid="category-windows">
              <thead>
                <tr>
                  <Th>Games</Th>
                  <Th right>GP</Th>
                  {CATEGORIES.map((c) => (
                    <Th key={c} right>
                      {CATEGORY_LABELS[c]}
                    </Th>
                  ))}
                  <Th right>Total</Th>
                </tr>
              </thead>
              <tbody>
                {windows.map((z) => (
                  <tr key={z.window_name} className="border-t border-line">
                    <Td>{WINDOW_LABEL[z.window_name] ?? z.window_name}</Td>
                    <Td right>{z.games}</Td>
                    {CATEGORIES.map((c) => (
                      <Td key={c} right>
                        <Signed value={z[c] as number | null} />
                      </Td>
                    ))}
                    <Td right>
                      <Signed value={z.z_total} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* the status strip (#726): injury, next games, news and moves together, near the top */}
      <div className="grid items-start gap-6 empty:hidden lg:grid-cols-2" data-testid="player-status">
        {player.board?.injury_group && <InjuryCard board={player.board} history={player.injury_history ?? []} />}
        {player.team.team_id && <NextGames games={schedule} teamId={player.team.team_id} />}
        {(player.news ?? []).length > 0 && <NewsCard news={player.news ?? []} />}
        {(player.moves ?? []).length > 0 && (
          <Card title="Moves" id="moves">
            <ul className="grid gap-1 text-sm" data-testid="player-moves">
              {(player.moves ?? []).map((m) => (
                <li key={`${m.transaction_date}-${m.description}`}>
                  <span className="mr-2 text-xs text-muted">{day(m.transaction_date)}</span>
                  {m.description}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <Card title={`Rolling 10-game trend, ${player.current_season ?? ''}`} id="trend">
        {player.rolling.length ? (
          <TrendChart
            rows={player.rolling}
            series={[
              { key: 'points_avg_10', label: 'PTS' },
              { key: 'minutes_avg_10', label: 'MIN' },
              { key: 'rebounds_total_avg_10', label: 'REB' },
              { key: 'assists_avg_10', label: 'AST' },
            ]}
            title="Ten-game rolling averages of points, minutes, rebounds and assists"
          />
        ) : (
          <p className="text-sm text-muted">No games this season yet.</p>
        )}
      </Card>

      <Card title="Season lines" id="seasons">
        <div className="table-scroll max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="Season lines">
          <table className="w-full text-sm" data-testid="season-lines">
            <thead>
              <tr>
                <Th>Season</Th>
                <Th right>GP</Th>
                <Th right>MIN</Th>
                <Th right>PTS</Th>
                <Th right>REB</Th>
                <Th right>AST</Th>
                <Th right>STL</Th>
                <Th right>BLK</Th>
                <Th right>3PM</Th>
                <Th right>TO</Th>
                <Th right>FG%</Th>
                <Th right>FT%</Th>
              </tr>
            </thead>
            <tbody>
              {player.seasons.map((s) => (
                <tr key={s.season} className="border-t border-line">
                  <Td>{s.season}</Td>
                  <Td right>{s.games_played}</Td>
                  <Td right>{fmt(s.minutes_pg)}</Td>
                  <Td right>{fmt(s.points_pg)}</Td>
                  <Td right>{fmt(s.rebounds_total_pg)}</Td>
                  <Td right>{fmt(s.assists_pg)}</Td>
                  <Td right>{fmt(s.steals_pg)}</Td>
                  <Td right>{fmt(s.blocks_pg)}</Td>
                  <Td right>{fmt(s.three_pointers_made_pg)}</Td>
                  <Td right>{fmt(s.turnovers_pg)}</Td>
                  <Td right>{pct(s.field_goal_pct)}</Td>
                  <Td right>{pct(s.free_throw_pct)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={`Shot chart, ${player.current_season ?? ''}`} id="shots">
      {/* the chart beside its zones: at the page's full width it would stand a screen tall (#726) */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
          {player.shots.length ? (
            <ShotChart shots={player.shots} league={target.league} title={`${player.name ?? ''} shot chart`} />
          ) : (
            <p className="text-sm text-muted">No shots this season yet.</p>
          )}
          {player.shot_zones.length > 0 && (
            <div className="table-scroll max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="Shot zones">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <Th>Zone</Th>
                    <Th right>FGA</Th>
                    <Th right>FG%</Th>
                    <Th right>League</Th>
                  </tr>
                </thead>
                <tbody>
                  {player.shot_zones
                    .filter((z) => z.zone !== 'Backcourt')
                    .map((z) => (
                      <tr key={z.zone} className="border-t border-line">
                        <Td>{z.zone}</Td>
                        <Td right>{z.attempts}</Td>
                        <Td right>{pct(z.pct)}</Td>
                        <Td right>{pct(z.league_pct)}</Td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
    
      </div>
    </Card>

      <Card title="Game log" id="games">
        <label className="text-sm">
          Season{' '}
          <select value={season} onChange={(e) => setSeason(e.target.value)} className="rounded border border-line bg-card px-2 py-1">
            {seasons.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <div className="mt-3 table-scroll max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="Game log">
          <table className="w-full text-sm" data-testid="game-log">
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Opp</Th>
                <Th right>MIN</Th>
                <Th right>PTS</Th>
                <Th right>REB</Th>
                <Th right>AST</Th>
                <Th right>STL</Th>
                <Th right>BLK</Th>
                <Th right>TO</Th>
                <Th right>FG</Th>
                <Th right>3P</Th>
                <Th right>FT</Th>
                <Th right>+/-</Th>
              </tr>
            </thead>
            <tbody>
              {seasonLog.map((g) => (
                <tr key={g.game_id} className="border-t border-line">
                  <Td>{day(g.game_date)}</Td>
                  <Td>
                    {g.is_home ? 'vs' : '@'} {g.opponent ?? '–'}
                  </Td>
                  {g.played ? (
                    <>
                      <Td right>{fmt(g.minutes, 0)}</Td>
                      <Td right>{g.points}</Td>
                      <Td right>{g.rebounds_total}</Td>
                      <Td right>{g.assists}</Td>
                      <Td right>{g.steals}</Td>
                      <Td right>{g.blocks}</Td>
                      <Td right>{g.turnovers}</Td>
                      <Td right>
                        {g.field_goals_made}-{g.field_goals_attempted}
                      </Td>
                      <Td right>
                        {g.three_pointers_made}-{g.three_pointers_attempted}
                      </Td>
                      <Td right>
                        {g.free_throws_made}-{g.free_throws_attempted}
                      </Td>
                      <Td right>
                        <Signed value={g.plus_minus} digits={0} />
                      </Td>
                    </>
                  ) : (
                    <td colSpan={11} className="px-2 py-1.5 text-muted">
                      {g.comment || 'Did not play'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-sm text-muted">
        Stints:{' '}
        {player.stints.map((s) => `${s.abbreviation ?? s.team_id} ${day(s.valid_from)} to ${s.valid_to ? day(s.valid_to) : 'now'}`).join(' · ')}
        {' · '}
        <a href={href('/')} className="underline-offset-4 hover:underline">
          Back to the board
        </a>
      </p>
    </div>
  );
}
