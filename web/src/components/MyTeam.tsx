import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { fetchBuildJson, fetchPageRows, type League } from '../lib/data';
import { CATEGORIES, CATEGORY_LABELS, fmt } from '../lib/format';
import { currentLeague } from '../lib/league';
import { href } from '../lib/site';
import { assign, owners, toggleIl, useLeague } from '../lib/fantasy-league';
import { categoryValues, pointValues } from '../lib/league-value';
import { dropRule, reviewRoster, type RosterReview, type Upgrade } from '../lib/roster-upgrades';
import { matchup, type WeekMatchup, weekTotals } from '../lib/matchup';
import { expectedWins, leagueStandings, type LeagueStandings } from '../lib/standings';
import { hasWeekGames, recentForm, type ValueUnit, weekValue } from '../lib/week-value';
import { IL_MIN_GAMES, ilMoves } from '../lib/il-moves';
import { easternDate, type TodayGame } from '../lib/today';
import { type ModelRow, restValues } from '../lib/board-model';
import { CategoryProfile, LeagueBar, Matchup, Today, type TodayRow, Upgrades } from './LeagueParts';
import { InjuryTag, injuryDetail, Loading, Problem, Signed, Td, Th } from './ui';

interface TeamRow extends ModelRow {
  full_name: string | null;
  team_abbreviation: string | null;
  team_id?: string | null;
  rank_total: number;
  market_rank?: number | null;
  availability_multiplier: number | null;
  games_remaining: number | null;
  games_this_week?: number | null;
  injury_status: string | null;
  injury_group: string | null;
  injury_type: string | null;
  expected_return: string | null;
  injury_note: string | null;
  expected_games_missed: number | null;
  lineup_role?: string | null;
  lineup_confirmed?: boolean | null;
  lineup_date?: string | null;
}

const button = 'rounded border border-line px-2 py-0.5 text-xs hover:bg-bg';

/** A card on the page: a heading, and what it holds. */
function Tile({ title, id, children, testid }: { title: string; id: string; children: ReactNode; testid?: string }) {
  return (
    <section className="min-w-0 rounded-lg border border-line bg-card p-3" aria-labelledby={`${id}-h`} data-testid={testid}>
      <h2 id={`${id}-h`} className="text-sm font-medium tracking-wide text-muted uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;

/**
 * Each kept category against the league (#662): the chance of beating an average rival, and the
 * team's place among the teams with rosters in. Replaces the board's "Weakest" and the League
 * page's category bars with what the standings model says the manager is likely to win.
 */
function Categories({
  standings,
  mine,
  cats,
  punted,
  h2h,
  totals,
}: {
  standings: LeagueStandings | null;
  mine: number;
  cats: string[];
  punted: string[];
  h2h: boolean;
  totals: Record<string, number> | null;
}) {
  const label = (c: string) => CATEGORY_LABELS[c] ?? c;
  const puntLine = punted.length > 0 && (
    <p className="mt-2 text-xs text-muted">
      Punted: {punted.map(label).join(', ')}. They count for nothing in your values and suggestions.
    </p>
  );
  if (!standings) {
    return (
      <Tile title="Your categories" id="cats" testid="my-categories">
        <p className="mt-1 text-sm text-muted" data-testid="cats-summary">
          Your team&apos;s value above replacement in each category. Add the other teams&apos; rosters on the{' '}
          <a href={href('/league/')} className="underline underline-offset-4">
            League page
          </a>{' '}
          to see your chance of beating them, category by category.
        </p>
        {totals && (
          <div className="mt-2">
            <CategoryProfile totals={totals} weakest={Object.entries(totals).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([c]) => c)} />
          </div>
        )}
        {puntLine}
      </Tile>
    );
  }
  // the manager's place in a category: 1 + the rivals whose total beats theirs
  const place = (c: string) => 1 + standings.others.filter((t) => (standings.totals[t]?.[c] ?? 0) > (standings.totals[mine]?.[c] ?? 0)).length;
  const wins = expectedWins(standings.chances);
  const order = cats.filter((c) => c in standings.chances);
  return (
    <Tile title="Your categories" id="cats" testid="my-categories">
      <p className="mt-1 text-sm" data-testid="cats-summary">
        {h2h ? (
          <>
            Against an average rival you project to win{' '}
            <strong>
              {fmt(wins, 1)} of {order.length} categories
            </strong>{' '}
            a week.
          </>
        ) : (
          <>
            You project to finish ahead of an average rival in{' '}
            <strong>
              {fmt(wins, 1)} of {order.length} categories
            </strong>
            .
          </>
        )}{' '}
        <span className="text-muted">Strengths to trade from are green; the categories a move should target are red.</span>
      </p>
      <ul className="mt-2 grid max-w-2xl gap-1 text-sm" data-testid="cat-chances">
        {order.map((c) => {
          const p = standings.chances[c] ?? 0.5;
          const tone = p >= 0.6 ? 'bg-good' : p <= 0.4 ? 'bg-bad' : 'bg-muted';
          const text = p >= 0.6 ? 'text-good' : p <= 0.4 ? 'text-bad' : 'text-muted';
          return (
            <li key={c} className="grid grid-cols-[3rem_minmax(0,1fr)_3rem_5.5rem] items-center gap-2" data-testid="cat-chance" data-cat={c}>
              <span className="font-medium">{label(c)}</span>
              <span className="h-2 overflow-hidden rounded bg-bg" aria-hidden="true">
                <span className={`block h-full ${tone}`} style={{ width: `${Math.round(p * 100)}%` }} />
              </span>
              <span className={`text-right tabular-nums ${text}`} title={`Chance of beating an average rival in ${label(c)}`}>
                {Math.round(p * 100)}%
              </span>
              <span className="text-xs text-muted">
                {ordinal(place(c))} of {standings.others.length + 1}
              </span>
            </li>
          );
        })}
      </ul>
      {puntLine}
    </Tile>
  );
}

export default function MyTeam() {
  const [league] = useState<League>(() => currentLeague());
  const [rows, setRows] = useState<TeamRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [games, setGames] = useState<TodayGame[] | null>(null);
  const [setup, updateLeague] = useLeague(league);

  useEffect(() => {
    let live = true;
    fetchPageRows<TeamRow>(`board/${league}`)
      .then((data) => live && setRows(data))
      .catch((e: unknown) => live && setError(e));
    fetchBuildJson<TodayGame[]>(`schedule/${league}.json`)
      .then((g) => live && setGames(g))
      .catch(() => live && setGames(null));
    return () => {
      live = false;
    };
  }, [league]);

  const owner = useMemo(() => owners(setup), [setup]);
  const points = setup.scoring === 'points';
  const h2h = setup.format === 'h2h';
  const pool = setup.teams * setup.rosterSpots;
  const punted = useMemo(() => (setup.scoring === 'cats8' ? [...setup.punts, 'z_turnovers'] : setup.punts), [setup.punts, setup.scoring]);
  const activeCats = useMemo(() => CATEGORIES.filter((c) => !punted.includes(c)), [punted]);
  const byId = useMemo(() => new Map((rows ?? []).map((r) => [r.player_id, r])), [rows]);
  const roster = useMemo(() => setup.rosters[setup.mine] ?? [], [setup.rosters, setup.mine]);
  const myTeam = useMemo(
    () => roster.filter((id) => !setup.il.includes(id)).map((id) => byId.get(id)).filter((r): r is TeamRow => !!r),
    [roster, setup.il, byId],
  );
  const remaining = useMemo(() => (rows ?? []).reduce((m, r) => Math.max(m, r.games_remaining ?? 0), 0), [rows]);

  const leagueCats = useMemo(() => (rows && !points ? categoryValues(rows, activeCats, pool, setup.teams) : null), [rows, points, activeCats, pool, setup.teams]);
  const leaguePoints = useMemo(() => (rows && points ? pointValues(rows, setup.weights, pool, setup.teams) : null), [rows, points, setup.weights, pool, setup.teams]);
  const restValue = useMemo(() => restValues(rows ?? [], { points, leaguePoints, leagueCats, activeCats }), [rows, points, leaguePoints, leagueCats, activeCats]);
  // last-ten form under the league's scoring: the week unit's per-game value (#466)
  const recentCats = useMemo(
    () => (rows && !points ? categoryValues(recentForm(rows, activeCats), activeCats, pool, setup.teams) : null),
    [rows, points, activeCats, pool, setup.teams],
  );
  const perGame = useCallback(
    (id: string, recent = false) =>
      points ? (leaguePoints?.get(id)?.value ?? 0) : activeCats.reduce((s, c) => s + ((recent ? recentCats : leagueCats)?.get(id)?.[c] ?? 0), 0),
    [points, leaguePoints, activeCats, recentCats, leagueCats],
  );

  const standings = useMemo(() => {
    if (!rows || !leagueCats || myTeam.length === 0) return null;
    return leagueStandings(league, setup, activeCats, (id) => leagueCats.get(id), (id) => byId.get(id)?.availability_multiplier ?? 1, remaining);
  }, [rows, leagueCats, myTeam.length, league, setup, activeCats, byId, remaining]);
  const myTotals = useMemo(
    () => (leagueCats && myTeam.length ? Object.fromEntries(activeCats.map((c) => [c, myTeam.reduce((s, r) => s + (leagueCats.get(r.player_id)?.[c] ?? 0), 0)])) : null),
    [leagueCats, myTeam, activeCats],
  );

  // the week unit for the moves, and this week's matchup
  const weekAvailable = useMemo(() => !!rows && hasWeekGames(rows), [rows]);
  const [unit, setUnit] = useState<ValueUnit>(h2h ? 'week' : 'rest');
  const week = unit === 'week' && weekAvailable;
  const weekValues = useMemo(() => {
    const out = new Map<string, number>();
    if (!week) return out;
    for (const r of rows ?? []) out.set(r.player_id, weekValue(perGame(r.player_id, true), r.games_this_week));
    return out;
  }, [rows, week, perGame]);
  const match = useMemo<WeekMatchup | null>(() => {
    if (!h2h || setup.opponent === null || !weekAvailable || myTeam.length === 0 || !rows) return null;
    const theirs = rows.filter((r) => owner.get(r.player_id) === setup.opponent && !setup.il.includes(r.player_id));
    const scoring = points ? setup.weights : undefined;
    return matchup(points ? [] : activeCats, weekTotals(myTeam, activeCats, scoring), weekTotals(theirs, activeCats, scoring));
  }, [h2h, setup.opponent, setup.weights, setup.il, weekAvailable, myTeam, rows, owner, points, activeCats]);

  const review = useMemo<RosterReview | null>(() => {
    if (!rows || myTeam.length === 0 || setup.drafting) return null;
    const cats = week ? recentCats : leagueCats;
    const totals = setup.rosters.map((r) =>
      Object.fromEntries(activeCats.map((c) => [c, r.filter((id) => !setup.il.includes(id)).reduce((s, id) => s + (cats?.get(id)?.[c] ?? 0), 0)])),
    );
    const mine = myTeam.map((r) => r.player_id);
    return reviewRoster({
      position: (id) => byId.get(id)?.position,
      droppable: dropRule(rows, mine, setup, restValue, week),
      mine,
      available: rows.filter((r) => !owner.has(r.player_id)).map((r) => r.player_id),
      rest: week ? weekValues : restValue,
      cats: points ? [] : activeCats,
      catValue: (id) => cats?.get(id),
      totals,
      myTeam: setup.mine,
    });
  }, [rows, myTeam, setup, week, recentCats, leagueCats, activeCats, byId, restValue, owner, weekValues, points]);
  const applyUpgrade = useCallback((u: Upgrade) => updateLeague((s) => assign(assign(s, u.drop, null), u.add, s.mine)), [updateLeague]);

  if (error) return <Problem error={error} />;
  if (!rows) return <Loading what="your team" />;

  if (roster.length === 0) {
    return (
      <div className="grid gap-3" data-testid="team-empty">
        <LeagueBar setup={setup} rostered={owner.size} myCount={0} weakest={[]} />
        <p className="rounded-lg border border-line bg-card p-3 text-sm">
          Your team is empty. Set up your league on the{' '}
          <a href={href('/league/')} className="font-medium text-accent underline-offset-4 hover:underline">
            League page
          </a>
          : import it from Yahoo, paste each roster, or draft there pick by pick. This page then shows your week, your categories against the league,
          your roster and the moves worth making.
        </p>
      </div>
    );
  }

  const moves = ilMoves(rows, roster, setup.il);
  const showMatchup = h2h && owner.size > 0 && !setup.drafting && weekAvailable;
  // a player headed for the IL is an IL move, not a trade chip
  const shown = review && { ...review, chips: review.chips.filter((id) => !moves.toIl.includes(id)) };
  const name = (id: string) => byId.get(id)?.full_name ?? id;
  const link = (id: string) => (
    <a href={href(`/p/${league}/${id}/`)} className="underline-offset-4 hover:underline">
      {name(id)}
    </a>
  );
  const sorted = [...roster].sort((a, b) => {
    const il = Number(setup.il.includes(a)) - Number(setup.il.includes(b));
    return il || (restValue.get(b) ?? 0) - (restValue.get(a) ?? 0);
  });

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <LeagueBar setup={setup} rostered={owner.size} myCount={myTeam.length} weakest={[]} />
      {setup.drafting && (
        <p className="rounded-lg border border-accent bg-card p-3 text-sm" data-testid="team-drafting">
          Your draft is under way on the{' '}
          <a href={href('/league/')} className="underline underline-offset-4">
            League page
          </a>
          ; moves wait until it ends.
        </p>
      )}

      {games && myTeam.length > 0 && !setup.drafting && <Today league={league} players={myTeam as unknown as TodayRow[]} games={games} date={easternDate()} />}

      {/* the week beside the season: this week's categories next to the league-wide chances */}
      <div className={`grid items-start gap-3 ${showMatchup && !points ? 'lg:grid-cols-2' : ''}`}>
        {showMatchup && <Matchup setup={setup} match={match} points={points} onOpponent={(t) => updateLeague((s) => ({ ...s, opponent: t }))} />}
        {!points && <Categories standings={standings} mine={setup.mine} cats={activeCats} punted={punted} h2h={h2h} totals={myTotals} />}
      </div>

      <Tile title="Roster" id="roster" testid="my-roster">
        {(moves.toIl.length > 0 || moves.back.length > 0) && (
          <div className="mt-1 grid gap-1 text-sm">
            {moves.toIl.length > 0 && (
              <p data-testid="il-candidates">
                <span className="text-muted">To the IL (expected to miss {IL_MIN_GAMES}+ games): </span>
                {moves.toIl.map((id) => (
                  <span key={id} className="mr-3 inline-flex flex-wrap items-center gap-1">
                    {link(id)}
                    <span className="text-xs text-muted">
                      {fmt(byId.get(id)?.expected_games_missed ?? 0, 1)} games
                      {byId.get(id)?.expected_return ? `, back ${byId.get(id)?.expected_return}` : ''}
                    </span>
                    <button type="button" className={button} onClick={() => updateLeague((s) => toggleIl(s, id))} data-testid="il-move">
                      Move to IL
                    </button>
                  </span>
                ))}
              </p>
            )}
            {moves.back.length > 0 && (
              <p data-testid="il-back">
                <span className="text-muted">Back from the IL (no longer listed): </span>
                {moves.back.map((id) => (
                  <span key={id} className="mr-3 inline-flex items-center gap-1">
                    {link(id)}
                    <button type="button" className={button} onClick={() => updateLeague((s) => toggleIl(s, id))} data-testid="il-move">
                      Activate
                    </button>
                  </span>
                ))}
              </p>
            )}
          </div>
        )}
        <div className="table-scroll mt-2 overflow-auto" tabIndex={0} role="region" aria-label="Your roster">
          <table className="w-full text-sm" data-testid="roster-table">
            <thead>
              <tr>
                <Th>Player</Th>
                <Th right>
                  <span title="Value above replacement over the games each player is expected to play from today">Rest of season</span>
                </Th>
                <Th right>
                  <span title="Value per game above replacement, from the projected line">Per game</span>
                </Th>
                {!points && (
                  <Th right>
                    <span title="Value per game above replacement over the last ten games">Last 10</span>
                  </Th>
                )}
                {weekAvailable && (
                  <Th right>
                    <span title="Team games left this fantasy week (Monday to Sunday)">Games this week</span>
                  </Th>
                )}
              </tr>
            </thead>
            <tbody>
              {sorted.map((id) => {
                const r = byId.get(id);
                const onIl = setup.il.includes(id);
                const pg = perGame(id);
                const recent = perGame(id, true);
                const form = recent - pg;
                return (
                  <tr key={id} className={`border-t border-line ${onIl ? 'text-muted' : ''}`} data-player={id}>
                    <Td>
                      <span className="flex flex-wrap items-center gap-1">
                        {link(id)}
                        <span className="text-xs text-muted">{[r?.position, r?.team_abbreviation].filter(Boolean).join(' · ')}</span>
                        {onIl && <span className="rounded border border-line px-1 text-[10px]">IL</span>}
                        {r && <InjuryTag group={r.injury_group} status={r.injury_status} detail={injuryDetail(r)} />}
                      </span>
                    </Td>
                    <Td right>
                      <strong>{fmt(restValue.get(id) ?? null, 1)}</strong>
                    </Td>
                    <Td right>
                      <Signed value={r ? pg : null} digits={1} />
                    </Td>
                    {!points && (
                      <Td right>
                        <span
                          className={form >= 1 ? 'text-good' : form <= -1 ? 'text-bad' : ''}
                          title={form >= 1 ? 'Playing above the projection' : form <= -1 ? 'Playing below the projection' : undefined}
                          data-testid="form"
                        >
                          <Signed value={r ? recent : null} digits={1} />
                          {form >= 1 ? ' ▲' : form <= -1 ? ' ▼' : ''}
                        </span>
                      </Td>
                    )}
                    {weekAvailable && <Td right>{onIl ? '–' : (r?.games_this_week ?? 0)}</Td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Tile>

      {shown && (
        <Upgrades
          league={league}
          review={shown}
          nameOf={name}
          detailOf={(id) => [byId.get(id)?.position, byId.get(id)?.team_abbreviation].filter(Boolean).join(', ')}
          onApply={applyUpgrade}
          unit={week ? 'week' : 'rest'}
          onUnit={weekAvailable ? setUnit : null}
          gamesOf={(id) => byId.get(id)?.games_this_week ?? 0}
        />
      )}
    </div>
  );
}
