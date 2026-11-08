import { useMemo } from 'react';

import type { League } from '../lib/data';
import { fmt } from '../lib/format';
import type { LeagueSetup } from '../lib/fantasy-league';
import { fixedPlayoffs, leagueRecords } from '../lib/league-state';
import { playoffOdds, pointsPlayoffOdds, type Week } from '../lib/playoff-odds';
import { gamesPlace, oddsText, playoffLead, playoffTargets, playoffWindow, rosterGames, type TargetRow, type TeamWeek, weeksToPlay, windowGames, windowText } from '../lib/playoff-weeks';
import { recordText } from '../lib/records';
import { href } from '../lib/site';
import { Td, Th, Tile } from './ui';

/** A board row as the plan reads it. */
export interface PlanRow extends TargetRow {
  full_name: string | null;
  team_abbreviation: string | null;
  availability_multiplier: number | null;
}

/**
 * The playoff push (#821), at the top of My Team in a head-to-head league: the chance of making
 * the playoffs, the roster's games in the playoff weeks against the league's, and the free agent
 * to target for them. How the odds are worked out, every team's odds and the next targets are one
 * click down.
 */
export function PlayoffPlan({
  league,
  setup,
  rows,
  teamWeeks,
  cats,
  catValue,
  fpts = null,
  perGame,
  owned,
  drops,
  roster,
  today,
}: {
  league: League;
  setup: LeagueSetup;
  rows: PlanRow[];
  teamWeeks: TeamWeek[];
  /** The categories the league counts (empty in a points league). */
  cats: string[];
  /** The league's category values; null in a points league, whose odds play out on `fpts`. */
  catValue: ((id: string) => Record<string, number> | undefined) | null;
  /** A points league's projected fantasy points per game (#877); null in a category league. */
  fpts?: ((id: string) => number) | null;
  perGame: (id: string) => number;
  owned: (id: string) => boolean;
  drops: readonly string[];
  roster: readonly string[];
  today: string;
}) {
  const byId = useMemo(() => new Map(rows.map((r) => [r.player_id, r])), [rows]);
  const espn = setup.source?.host === 'espn' ? setup.source : undefined;
  // the import's playoff weeks, or the first week entered by hand (#874), else the schedule's last
  const fixed = useMemo(() => fixedPlayoffs(setup), [setup]);
  const window = useMemo(() => playoffWindow(teamWeeks, setup.playoffs.weeks, fixed), [teamWeeks, setup.playoffs.weeks, fixed]);
  const games = useMemo(() => (window ? windowGames(teamWeeks, window, today) : new Map<string, number>()), [teamWeeks, window, today]);
  const gamesOf = (id: string) => games.get(byId.get(id)?.team_id ?? '') ?? 0;
  const perTeam = rosterGames(setup.rosters, setup.il, gamesOf);
  const allRosters = setup.rosters.every((r) => r.length > 0);
  // the records the odds start from: the import's, else those entered by hand (#874)
  const recorded = useMemo(() => leagueRecords(setup), [setup]);

  // the regular season left: ESPN's schedule from this week on, or a round robin over the weeks before the playoffs
  const schedule = useMemo(() => {
    if (!window) return null;
    const weeks: Week[] = espn?.fixtures ?? weeksToPlay(teamWeeks, window, today, setup.teams);
    return { weeks, records: recorded?.records ?? [], tally: recorded?.tally ?? 'categories' };
  }, [window, espn, teamWeeks, today, setup.teams, recorded]);
  const odds = useMemo(() => {
    if (!schedule) return null;
    const availability = (id: string) => byId.get(id)?.availability_multiplier ?? 1;
    if (catValue) return playoffOdds(league, setup, cats, catValue, availability, schedule);
    // a points league: each week on fantasy points, with a spread measured on past seasons (#877, #891)
    return fpts ? pointsPlayoffOdds(league, setup, fpts, availability, schedule) : null;
  }, [catValue, fpts, schedule, league, setup, cats, byId]);
  const pointsOdds = !!odds && !catValue;
  const targets = useMemo(
    () =>
      playoffTargets({
        rows,
        games,
        perGame,
        owned,
        allRosters,
        pool: setup.teams * setup.rosterSpots,
        drops,
        roster,
        position: (id) => byId.get(id)?.position,
        kept: cats,
        limit: 3, // display: the top three targets
      }),
    [rows, games, perGame, owned, allRosters, setup.teams, setup.rosterSpots, drops, roster, byId, cats],
  );

  if (!window || today > window.to) return null;
  const mine = perTeam[setup.mine] ?? 0;
  const place = gamesPlace(perTeam, setup.rosters, setup.mine);
  const lead = playoffLead(odds ? (odds.odds[setup.mine] ?? 0) : null, mine, place, window);
  const name = (id: string) => byId.get(id)?.full_name ?? id;
  const link = (id: string) => (
    <a href={href(`/p/${league}/${id}/`)} className="font-medium text-accent underline-offset-4 hover:underline" data-testid="playoff-target">
      {name(id)}
    </a>
  );
  const [top] = targets;
  const order = setup.rosters.map((_, t) => t).sort((a, b) => (odds ? (odds.odds[b] ?? 0) - (odds.odds[a] ?? 0) : 0) || (perTeam[b] ?? 0) - (perTeam[a] ?? 0));
  const levelStart = !recorded;
  const recordsText =
    recorded?.from === 'espn' ? "ESPN's records at the last sync" : recorded?.from === 'yahoo' ? "Yahoo's records at the last import" : 'the records entered on the League page';

  return (
    <Tile title="Playoffs" id="playoffs" testid="playoffs" issue={odds ? (pointsOdds ? 913 : 900) : undefined}>
      <p className="mt-1 text-sm" data-testid="playoff-line">
        <strong>{lead}</strong>
        {top && (
          <>
            : target {link(top.row.player_id)} ({top.games} {top.games === 1 ? 'game' : 'games'})
          </>
        )}
      </p>
      <details className="mt-2 text-sm" data-testid="playoff-details">
        <summary className="cursor-pointer text-xs text-muted">How it is worked out, every team and the next targets</summary>
        <p className="mt-2 text-xs text-muted" data-testid="playoff-basis">
          {odds ? (
            <>
              The top {Math.min(setup.playoffs.teams, setup.teams)} of {setup.teams} make the playoffs. The odds play the regular season&apos;s{' '}
              {schedule?.weeks.length ?? 0} {schedule?.weeks.length === 1 ? 'week' : 'weeks'} left out{' '}
              {espn?.fixtures ? "on ESPN's schedule" : 'as a round robin'},{' '}
              {pointsOdds
                ? "each matchup going to a side by its projected fantasy points, with a week's swing measured on past seasons,"
                : "each category of each matchup going to a side with the standings model's chance, a projection's miss for each team carried through the whole season,"}{' '}
              from {levelStart ? 'level records' : recordsText}.{' '}
              {levelStart && "Enter each team's record on the League page (or import the league from ESPN or run the Yahoo bookmark) to start from the real standings. "}
            </>
          ) : (
            <>The odds need every team’s roster in (at least half of it) on the League page. </>
          )}
          Games are each active player&apos;s team&apos;s games in {windowText(window)}; the targets are free agents ranked as Pickups ranks them, by value per
          game times those games, each with the player Moves would drop for him.{' '}
          {!fixed && "The playoff weeks are taken to be the schedule's last; most hosts end theirs sooner, so set the first playoff week. "}
          <a href={href('/league/')} className="underline underline-offset-4">
            Set the playoffs on the League page.
          </a>
        </p>
        <div className="table-scroll mt-2 overflow-auto" tabIndex={0} role="region" aria-label="Playoff odds and games, team by team">
          <table className="w-full text-sm" data-testid="playoff-table">
            <thead>
              <tr>
                <Th>Team</Th>
                {recorded && <Th right>W-L-T</Th>}
                {odds && <Th right>Playoffs</Th>}
                <Th right>
                  <span title={`Games in ${windowText(window)}`}>Playoff games</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {order.map((t) => {
                const record = recorded?.records[t];
                return (
                  <tr key={t} className={`border-t border-line ${t === setup.mine ? 'font-semibold' : ''}`} data-testid="playoff-row">
                    <Td>{setup.names[t] ?? `Team ${t + 1}`}</Td>
                    {recorded && <Td right>{record ? recordText(record) : '–'}</Td>}
                    {odds && <Td right>{oddsText(odds.odds[t] ?? 0)}</Td>}
                    <Td right>{perTeam[t] ?? 0}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {targets.length > 0 && (
          <ul className="mt-2 grid gap-1" data-testid="playoff-targets">
            {targets.map((a) => (
              <li key={a.row.player_id} data-testid="playoff-target-row">
                {link(a.row.player_id)}{' '}
                <span className="text-xs text-muted">
                  {[a.row.source.position, a.row.source.team_abbreviation].filter(Boolean).join(' · ')} · {a.games} {a.games === 1 ? 'game' : 'games'} · value{' '}
                  {fmt(a.row.window_value, 1)}
                  {a.drop ? ` · for ${name(a.drop)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </Tile>
  );
}
