// The schedule parts of the Pickups page (moved out of Streamers.tsx, #819): the window's games by
// day, the games per fantasy week to the end, and the moves that change a rotation.
import type { League } from '../lib/data';
import { day, lineSource } from '../lib/format';
import { movesRotation } from '../lib/rotation-moves';
import { type CrewFields, crewText } from '../lib/referees';
import { href } from '../lib/site';
import { Card, Td, Th } from './ui';

export interface Game extends CrewFields {
  game_id: string;
  game_date: string;
  days_ahead: number;
  game_type: string;
  home_team_id: string;
  home_team_tricode: string;
  away_team_id: string;
  away_team_tricode: string;
  home_matchup: number | null;
  away_matchup: number | null;
  /** The betting line, where the sportsbooks have posted one (silver game_lines). */
  home_spread?: number | null;
  /** Who posted the line and the day it was taken (#462). */
  line_provider?: string | null;
  line_as_of?: string | null;
  over_under?: number | null;
  home_implied_points?: number | null;
  away_implied_points?: number | null;
  /** Rest and travel (fct_team_game_context). */
  home_back_to_back?: boolean | null;
  away_back_to_back?: boolean | null;
  away_miles_travelled?: number | null;
  at_altitude?: boolean | null;
}

/** A team's side of a game in the week grid: the opponent, and the points the line implies. */
interface GridCell {
  label: string;
  implied: number | null;
  line: string | null;
  /** The second night of a back-to-back for this team. */
  backToBack: boolean;
  /** Played 4,000 feet up or more. */
  altitude: boolean;
  miles: number | null;
  /** The referee crew's chief and tendency, once assigned. */
  crew: string | null;
}

function lineText(g: Game): string | null {
  if (typeof g.over_under !== 'number' || typeof g.home_spread !== 'number') return null;
  const favourite = g.home_spread <= 0 ? g.home_team_tricode : g.away_team_tricode;
  const spread = g.home_spread === 0 ? 'even' : `${favourite} -${Math.abs(g.home_spread)}`;
  const source = lineSource(g.line_provider, g.line_as_of);
  return `Over/under ${g.over_under}, ${spread}${source ? ` (${source})` : ''}`;
}

/** A signing, waiver, trade or G League move (gold fct_transaction). */
export interface Move {
  transaction_date: string;
  team_abbreviation: string | null;
  player_id: string | null;
  move_type: string;
  description: string;
}

const MOVE_LABEL: Record<string, string> = {
  signing: 'Signed',
  waive: 'Waived',
  trade: 'Trade',
  g_league: 'G League',
  recall: 'Recalled',
  suspension: 'Suspended',
  other: 'Other',
};

/** The league's moves of the last two weeks that open or close minutes: ten at most. */
export function RecentMoves({ moves, league, start, minutes }: { moves: Move[]; league: League; start: string; minutes: (id: string) => number | null }) {
  const since = addDays(start, -14);
  const recent = moves.filter((m) => m.transaction_date >= since && movesRotation(m, minutes)).slice(0, 10);
  if (!recent.length) return null;
  return (
    <Card title="Moves that change a rotation" id="moves">
      <p className="mb-2 text-xs text-muted">
        Trades, standard signings, and players with real minutes waived or suspended, in the last two weeks: a new role on a new team, or minutes opening up
        behind a player who left.
      </p>
      <ul className="grid gap-1 text-sm" data-testid="recent-moves">
        {recent.map((m) => (
          <li key={`${m.transaction_date}-${m.team_abbreviation}-${m.description}`} className="flex flex-wrap items-baseline gap-x-2">
            <span className="w-20 shrink-0 text-xs text-muted">{day(m.transaction_date)}</span>
            <span className="w-10 shrink-0 font-medium">{m.team_abbreviation ?? '–'}</span>
            <span className="rounded border border-line px-1 text-[10px] text-muted">{MOVE_LABEL[m.move_type] ?? m.move_type}</span>
            <span className="min-w-0 flex-1">
              {m.player_id ? (
                <a href={href(`/p/${league}/${m.player_id}/`)} className="underline-offset-4 hover:underline">
                  {m.description}
                </a>
              ) : (
                m.description
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Games per team per fantasy week for the rest of the season (fct_team_week_games). */
export interface TeamWeek {
  league: string;
  season: string;
  team_id: string;
  team_abbreviation: string | null;
  fantasy_week: string;
  week_start: string;
  week_end: string;
  is_current_week: boolean;
  games: number;
  games_left: number;
  games_if_necessary: number;
  game_dates: string | null;
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Built once, as in lib/format.ts (#557).
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const DAY_LABEL = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

export function weekday(iso: string): string {
  return WEEKDAY.format(new Date(`${iso}T00:00:00Z`));
}

/** "Mon, Nov 9". */
export function dayLabel(iso: string): string {
  return DAY_LABEL.format(new Date(`${iso}T00:00:00Z`));
}

export function WeekGrid({ games, teams, days, picked }: { games: Game[]; teams: string[]; days: string[]; picked: Set<string> }) {
  const inRange = new Set(days);
  const byTeamDay = new Map<string, GridCell>();
  const perDay = new Map<string, number>();
  for (const g of games) {
    if (!inRange.has(g.game_date)) continue;
    const line = lineText(g);
    const altitude = !!g.at_altitude;
    const crew = crewText(g);
    byTeamDay.set(`${g.home_team_tricode}|${g.game_date}`, {
      label: `v ${g.away_team_tricode}`,
      implied: g.home_implied_points ?? null,
      line,
      backToBack: !!g.home_back_to_back,
      // the home team plays at its own altitude every other night: only the visitor is marked
      altitude: false,
      miles: null,
      crew,
    });
    byTeamDay.set(`${g.away_team_tricode}|${g.game_date}`, {
      label: `@ ${g.home_team_tricode}`,
      implied: g.away_implied_points ?? null,
      line,
      backToBack: !!g.away_back_to_back,
      altitude,
      miles: g.away_miles_travelled ?? null,
      crew,
    });
    perDay.set(g.game_date, (perDay.get(g.game_date) ?? 0) + 2);
  }
  const counts = new Map(teams.map((t) => [t, days.filter((d) => byTeamDay.has(`${t}|${d}`)).length]));
  const ordered = [...teams].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
  const busiest = Math.max(0, ...days.map((d) => perDay.get(d) ?? 0));
  return (
    <div className="table-scroll max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="Games by day">
      <table className="w-full text-sm" data-testid="week-grid">
        <thead>
          <tr>
            <Th>Team</Th>
            <Th right>Games</Th>
            {days.map((d) => {
              const n = perDay.get(d) ?? 0;
              const light = n > 0 && n <= busiest / 2;
              return (
                <th
                  key={d}
                  scope="col"
                  className={`px-2 py-1.5 text-center text-xs font-medium whitespace-nowrap ${picked.has(d) ? 'text-accent' : 'text-muted'}`}
                >
                  {weekday(d)} {d.slice(5).replace('-', '/')}
                  <div className={light ? 'font-semibold text-good' : ''} title={light ? 'Light day: fewer teams play, so a streamer fills a lineup spot more easily' : undefined}>
                    {n} teams{light ? ' · light' : ''}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {ordered.map((t) => (
            <tr key={t} className="border-t border-line">
              <Td>{t}</Td>
              <Td right>
                <strong>{counts.get(t) ?? 0}</strong>
              </Td>
              {days.map((d) => {
                const cell = byTeamDay.get(`${t}|${d}`);
                return (
                  <td
                    key={d}
                    className={`px-2 py-1.5 text-center text-xs whitespace-nowrap ${cell ? 'bg-accent/10 font-medium' : 'text-muted'}`}
                    title={
                      cell
                        ? [
                            cell.line ? `${cell.line}: ${t} implied ${cell.implied} points` : null,
                            cell.backToBack ? 'Second night of a back-to-back: rest and minutes risk' : null,
                            cell.miles ? `${cell.miles} miles from the previous game` : null,
                            cell.altitude ? 'Visiting at altitude (4,000 ft or more)' : null,
                            cell.crew,
                          ]
                            .filter(Boolean)
                            .join('. ') || undefined
                        : undefined
                    }
                  >
                    {cell?.label ?? '·'}
                    {cell?.backToBack && (
                      <span className="ml-1 rounded border border-bad bg-card px-0.5 text-[11px] font-semibold text-bad" data-testid="back-to-back">
                        B2B
                      </span>
                    )}
                    {cell && typeof cell.implied === 'number' && (
                      <div className="text-[10px] font-normal text-muted" data-testid="implied-points">
                        {Math.round(cell.implied)} pts
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Games per team per fantasy week, this week to the last scheduled game: busiest teams first. */
export function WeeksGrid({ weeks }: { weeks: TeamWeek[] }) {
  const columns = [...new Map(weeks.map((w) => [w.fantasy_week, w])).values()].sort((a, b) => a.week_start.localeCompare(b.week_start));
  const label = (w: TeamWeek) => w.team_abbreviation ?? w.team_id;
  const teams = [...new Set(weeks.map(label))];
  const cell = new Map(weeks.map((w) => [`${label(w)}|${w.fantasy_week}`, w]));
  // In the current week only the games still to come count: a manager picking up today reads what is left.
  const remaining = (w: TeamWeek | undefined) => (w ? (w.is_current_week ? w.games_left : w.games) : 0);
  const total = new Map(teams.map((t) => [t, columns.reduce((n, c) => n + remaining(cell.get(`${t}|${c.fantasy_week}`)), 0)]));
  const ordered = [...teams].sort((a, b) => (total.get(b) ?? 0) - (total.get(a) ?? 0) || a.localeCompare(b));
  return (
    <div className="table-scroll max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="Games per fantasy week">
      <table className="w-full text-sm" data-testid="weeks-grid">
        <thead>
          <tr>
            <Th>Team</Th>
            <Th right>Games</Th>
            {columns.map((c) => (
              <th
                key={c.fantasy_week}
                scope="col"
                className={`px-2 py-1.5 text-center text-xs font-medium whitespace-nowrap ${c.is_current_week ? 'text-accent' : 'text-muted'}`}
                title={`${c.week_start} to ${c.week_end}`}
              >
                W{c.fantasy_week.slice(-2)}
                <div>{c.week_start.slice(5).replace('-', '/')}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordered.map((t) => (
            <tr key={t} className="border-t border-line">
              <Td>{t}</Td>
              <Td right>{total.get(t) ?? 0}</Td>
              {columns.map((c) => {
                const w = cell.get(`${t}|${c.fantasy_week}`);
                const n = remaining(w);
                const tone = n >= 4 ? 'font-semibold text-good' : n <= 2 ? 'text-muted' : '';
                const title =
                  w && c.is_current_week
                    ? `${w.games_left} of ${w.games} left this week${w.game_dates ? ` (${w.game_dates})` : ''}`
                    : (w?.game_dates ?? undefined);
                return (
                  <td
                    key={c.fantasy_week}
                    className={`px-2 py-1.5 text-center tabular-nums ${tone}`}
                    title={title}
                    data-testid={c.is_current_week ? 'week-left' : undefined}
                  >
                    {n}
                    {w && c.is_current_week ? <span className="text-xs text-muted"> of {w.games}</span> : null}
                    {w && w.games_if_necessary > 0 ? <span className="text-xs text-muted"> +{w.games_if_necessary}</span> : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
