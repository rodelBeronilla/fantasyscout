import { useEffect, useMemo, useState } from 'react';

import { fetchBuildJson, type League } from '../lib/data';
import { day, fmt } from '../lib/format';
import { currentLeague } from '../lib/league';
import { href } from '../lib/site';
import { Card, Loading, Problem, Signed, Td, Th } from './ui';

interface StreamerRow {
  player_id: string;
  full_name: string | null;
  position: string | null;
  team_id: string | null;
  season: string | null;
  games_next_7: number;
  last_game_date: string | null;
  minutes_avg_5: number | null;
  minutes_avg_20: number | null;
  minutes_trend: number | null;
  points_avg_5: number | null;
  rebounds_total_avg_5: number | null;
  assists_avg_5: number | null;
  games_in_window_20: number | null;
}

interface Team {
  league: string;
  season: string;
  team_id: string;
  abbreviation: string;
  name: string | null;
}

export default function Streamers() {
  const [league] = useState<League>(() => currentLeague());
  const [rows, setRows] = useState<StreamerRow[] | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    Promise.all([fetchBuildJson<StreamerRow[]>(`streamers/${league}.json`), fetchBuildJson<Team[]>('dim_team.json')])
      .then(([s, t]) => {
        if (!live) return;
        setRows(s);
        setTeams(t.filter((x) => x.league === league));
      })
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, [league]);

  const abbreviation = useMemo(() => {
    const latest = new Map<string, Team>();
    for (const t of teams) {
      const seen = latest.get(t.team_id);
      if (!seen || seen.season < t.season) latest.set(t.team_id, t);
    }
    return (id: string | null) => (id && latest.get(id)?.abbreviation) || '–';
  }, [teams]);

  const byTeam = useMemo(() => {
    const games = new Map<string, number>();
    for (const r of rows ?? []) if (r.team_id) games.set(r.team_id, Math.max(games.get(r.team_id) ?? 0, r.games_next_7));
    return [...games.entries()].sort((a, b) => b[1] - a[1] || abbreviation(a[0]).localeCompare(abbreviation(b[0])));
  }, [rows, abbreviation]);

  if (error) return <Problem error={error} />;
  if (!rows) return <Loading what="streamers" />;

  const inSeason = byTeam.some(([, n]) => n > 0);
  const trending = rows
    .filter((r) => r.minutes_trend !== null && (r.games_in_window_20 ?? 0) >= 5)
    .sort((a, b) => (b.minutes_trend ?? 0) - (a.minutes_trend ?? 0))
    .slice(0, 40);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <Card title="Games in the next 7 days" id="schedule">
        {inSeason ? (
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3" data-testid="games-next-7">
            {byTeam.map(([teamId, n]) => (
              <li key={teamId} className="flex justify-between border-b border-line py-1">
                <span>{abbreviation(teamId)}</span>
                <span className="tabular-nums">{n}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">
            No games scheduled in the next seven days. This league is between seasons; the minutes trend below
            reflects the end of the last one.
          </p>
        )}
      </Card>
      <Card title="Trending up in minutes" id="trending">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="trending">
            <thead>
              <tr>
                <Th>Player</Th>
                <Th>Team</Th>
                <Th>Pos</Th>
                <Th right>Min (5)</Th>
                <Th right>Min (20)</Th>
                <Th right>Trend</Th>
                <Th right>PTS (5)</Th>
                <Th right>REB (5)</Th>
                <Th right>AST (5)</Th>
                <Th right>Next 7</Th>
                <Th>Last game</Th>
              </tr>
            </thead>
            <tbody>
              {trending.map((r) => (
                <tr key={r.player_id} className="border-t border-line">
                  <Td>
                    <a href={href(`/p/${league}/${r.player_id}/`)} className="underline-offset-4 hover:underline">
                      {r.full_name ?? r.player_id}
                    </a>
                  </Td>
                  <Td>{abbreviation(r.team_id)}</Td>
                  <Td>{r.position ?? '–'}</Td>
                  <Td right>{fmt(r.minutes_avg_5)}</Td>
                  <Td right>{fmt(r.minutes_avg_20)}</Td>
                  <Td right>
                    <Signed value={r.minutes_trend} digits={1} />
                  </Td>
                  <Td right>{fmt(r.points_avg_5)}</Td>
                  <Td right>{fmt(r.rebounds_total_avg_5)}</Td>
                  <Td right>{fmt(r.assists_avg_5)}</Td>
                  <Td right>{r.games_next_7}</Td>
                  <Td>{day(r.last_game_date)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
