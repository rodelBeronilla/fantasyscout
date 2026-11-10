import { useEffect, useMemo, useState } from 'react';

import { fetchBuildJson, type League } from '../lib/data';
import { CATEGORIES, CATEGORY_LABELS, day, fmt, pct } from '../lib/format';
import { isLeague } from '../lib/league';
import type { PlayerFile, Upcoming, Zscore } from '../lib/player-file';
import { href } from '../lib/site';
import { PlayerNoteBox } from './PlayerNoteLine';
import { LeagueStatus, OutlookCard } from './PlayerOutlook';
import { InjuryCard, NewsCard, NextGames } from './PlayerStatusCards';
import ShotChart from './ShotChart';
import TrendChart from './TrendChart';
import { Card, Loading, Problem, Signed, Td, Th } from './ui';

/** The z-score windows the player file carries, in the order the page lists them. */
const WINDOWS = ['season', 'last_20', 'last_10'] as const;
const WINDOW_LABEL: Record<string, string> = { season: 'Season', last_20: 'Last 20', last_10: 'Last 10' };

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
        <h1 className="mt-1 title-page" data-testid="player-name">
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

      {/* a flagged player's note (#879): the call first, before the outlook */}
      {player.board && <PlayerNoteBox league={target.league} row={{ ...player.board, player_id: player.player_id }} />}

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
