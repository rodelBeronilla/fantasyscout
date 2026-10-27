import { useEffect, useMemo, useState } from 'react';

import { fetchBuildJson, type League } from '../lib/data';
import { CATEGORIES, CATEGORY_LABELS, day, fmt, pct } from '../lib/format';
import { isLeague } from '../lib/league';
import { href } from '../lib/site';
import ShotChart from './ShotChart';
import TrendChart from './TrendChart';
import { Badge, Card, Loading, Problem, Signed, Td, Th } from './ui';

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

interface Zscore {
  window_name: string;
  season: string;
  games: number;
  z_total: number | null;
  [key: string]: unknown;
}

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
  rolling: { game_number: number; game_date: string; [key: string]: unknown }[];
  zscores: Zscore[];
  board: { rank_total: number; value_total: number | null; value_rest_of_season: number | null } | null;
  shots: [number, number, number, number][];
  shot_zones: { zone: string; attempts: number; made: number; pct: number | null; league_pct: number | null }[];
}

function parsePath(): { league: League; playerId: string } | null {
  const m = /^\/p\/(wnba|nba)\/([^/]+)\/?$/.exec(window.location.pathname);
  if (!m || !isLeague(m[1])) return null;
  return { league: m[1], playerId: decodeURIComponent(m[2] ?? '') };
}

function agreementTone(s: string): 'good' | 'warn' | 'bad' | 'muted' {
  return s === 'exact' ? 'good' : s === 'minor' ? 'warn' : s === 'conflict' ? 'bad' : 'muted';
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

  return (
    <div className="grid gap-6">
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
          {player.board ? ` · Board rank #${player.board.rank_total}` : ''}
          {player.last_game_date ? ` · Last game ${day(player.last_game_date)}` : ''}
        </p>
      </header>

      <Card title="Season lines" id="seasons">
        <div className="overflow-x-auto">
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
                <Th>Sources agree</Th>
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
                  <Td>
                    <span className="text-xs text-muted">
                      {s.agree_exact} exact · {s.agree_minor} minor · {s.agree_conflict} conflict · {s.agree_unverified} unverified
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
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
        <Card title={`Shot chart, ${player.current_season ?? ''}`} id="shots">
          {player.shots.length ? (
            <ShotChart shots={player.shots} league={target.league} title={`${player.name ?? ''} shot chart`} />
          ) : (
            <p className="text-sm text-muted">No shots this season yet.</p>
          )}
          {player.shot_zones.length > 0 && (
            <table className="mt-3 w-full text-sm">
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
          )}
        </Card>
      </div>

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
        <div className="mt-3 overflow-x-auto">
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
                <Th>Sources</Th>
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
                  <Td>
                    <Badge tone={agreementTone(g.source_agreement)}>{g.source_agreement}</Badge>
                  </Td>
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
