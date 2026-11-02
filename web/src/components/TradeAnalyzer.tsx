/**
 * The Trade page: what each side of a trade is worth under the manager's league settings, how the
 * manager's team changes category by category, and a verdict. Players come from the league's
 * rosters when the League page has them, or from a search over the whole board.
 */
import { useEffect, useMemo, useState } from 'react';

import { fetchBuildJson, type League } from '../lib/data';
import { CATEGORIES, CATEGORY_LABELS, fmt, pct } from '../lib/format';
import { currentLeague } from '../lib/league';
import { DEFAULT_SETTINGS, isDefaultSettings, owners, useLeague } from '../lib/fantasy-league';
import { categoryValues, pointValues } from '../lib/league-value';
import { href } from '../lib/site';
import { nearestInValue, openSide, type Suggestion, suggestTrades } from '../lib/trade-suggest';
import { hasWeekGames, recentForm, type ValueUnit, weekValue } from '../lib/week-value';
import { describeSettings } from './LeagueParts';
import { PlayerPicker } from './PlayerPicker';
import { Card, InjuryTag, injuryDetail, Loading, Problem, Segmented, Signed, Td, Th } from './ui';

interface PlayerRow {
  player_id: string;
  full_name: string | null;
  position: string | null;
  team_abbreviation: string | null;
  games_share: number | null;
  ros_factor: number | null;
  availability_multiplier?: number | null;
  season_complete: boolean;
  games_remaining: number | null;
  injury_status: string | null;
  injury_group: string | null;
  injury_type?: string | null;
  games_this_week?: number | null;
  expected_return?: string | null;
  injury_note?: string | null;
  injury_news?: string | null;
  injury_since?: string | null;
  injury_source?: string | null;
  official_game_date?: string | null;
  official_report_at?: string | null;
  [key: string]: unknown;
}

/** A player's worth under the league's settings: per game, over the season, for the rest of it, and for this fantasy week. */
interface Worth {
  perGame: number;
  season: number;
  rest: number;
  week: number;
  cats: Record<string, number>;
  fpts: number | null;
}

type Side = 'give' | 'get';

const input = 'rounded border border-line bg-bg px-2 py-1 text-sm';
const button = 'rounded border border-line px-2 py-1 text-xs hover:bg-bg disabled:opacity-50';

const optionLabel = (p: PlayerRow) => `${p.full_name ?? p.player_id} · ${p.team_abbreviation ?? 'FA'} · ${p.position ?? '–'}`;


/** The figure a trade is judged on, as a short label: the rest of the season, or this fantasy week (#466). */
const UNIT_TEXT: Record<ValueUnit, string> = { rest: 'rest of season', week: 'rest of this fantasy week' };

export default function TradeAnalyzer() {
  const [league] = useState<League>(() => currentLeague());
  const [rows, setRows] = useState<PlayerRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [setup] = useLeague(league);
  const [give, setGive] = useState<string[]>([]);
  const [get, setGet] = useState<string[]>([]);
  const [partner, setPartner] = useState<number | null>(null);
  const [unit, setUnit] = useState<ValueUnit>('rest');

  useEffect(() => {
    let live = true;
    fetchBuildJson<PlayerRow[]>(`board/${league}.json`)
      .then((data) => live && setRows(data))
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, [league]);

  const owner = useMemo(() => owners(setup), [setup]);
  const hasRosters = owner.size > 0;
  const byId = useMemo(() => new Map((rows ?? []).map((r) => [r.player_id, r])), [rows]);
  const pool = setup.teams * setup.rosterSpots;
  const points = setup.scoring === 'points';
  const cats = useMemo(() => CATEGORIES.filter((c) => setup.scoring !== 'cats8' || c !== 'z_turnovers'), [setup.scoring]);
  const catValues = useMemo(() => (rows && !points ? categoryValues(rows, cats, pool, setup.teams) : null), [rows, points, cats, pool, setup.teams]);
  const pointVals = useMemo(() => (rows && points ? pointValues(rows, setup.weights, pool, setup.teams) : null), [rows, points, pool, setup.teams, setup.weights]);
  // The week unit is offered while the week has games left; it re-measures the categories on last-ten form.
  const weekAvailable = useMemo(() => !!rows && hasWeekGames(rows), [rows]);
  const week = unit === 'week' && weekAvailable;
  // After the last game the season's value is the projection for the next one (#450).
  const complete = !!rows?.length && rows.every((r) => r.season_complete);
  const REST = week ? UNIT_TEXT.week : complete ? 'next season' : UNIT_TEXT.rest;
  const recentCats = useMemo(
    () => (rows && !points && week ? categoryValues(recentForm(rows, cats), cats, pool, setup.teams) : null),
    [rows, points, week, cats, pool, setup.teams],
  );

  // The partner defaults to the first team that is not the manager's.
  const partnerTeam = partner ?? setup.names.findIndex((_, i) => i !== setup.mine);

  const worth = useMemo(() => {
    const out = new Map<string, Worth>();
    for (const r of rows ?? []) {
      const c: Record<string, number> = {};
      if (catValues) for (const k of cats) c[k] = catValues.get(r.player_id)?.[k] ?? 0;
      const pv = pointVals?.get(r.player_id);
      const perGame = points ? (pv?.value ?? 0) : cats.reduce((s, k) => s + (c[k] ?? 0), 0);
      // Only value above replacement counts games: a missed game from a player not worth rostering costs nothing.
      const season = perGame > 0 ? perGame * (r.games_share ?? 1) : perGame;
      const rest = season > 0 && !r.season_complete ? season * (r.ros_factor ?? 1) : season;
      const recent = points ? perGame : cats.reduce((s, k) => s + (recentCats?.get(r.player_id)?.[k] ?? 0), 0);
      out.set(r.player_id, { perGame, season, rest, week: weekValue(recent, r.games_this_week), cats: c, fpts: pv ? pv.fpts : null });
    }
    return out;
  }, [rows, catValues, pointVals, points, cats, recentCats]);

  const options = useMemo(() => new Map((rows ?? []).map((p) => [optionLabel(p), p.player_id])), [rows]);

  if (error) return <Problem error={error} />;
  if (!rows) return <Loading what="the board" />;

  // The figure each side is judged on: the rest of the season, or this fantasy week.
  const NONE: Worth = { perGame: 0, season: 0, rest: 0, week: 0, cats: {}, fpts: null };
  const pick = (w: Worth) => (week ? w.week : w.rest);
  const sideOf = (ids: string[]) => {
    const players = ids.map((id) => byId.get(id)).filter((p): p is PlayerRow => !!p);
    const sum = (f: (w: Worth) => number) =>
      players.reduce((s, p) => s + f(worth.get(p.player_id) ?? NONE), 0);
    const catTotals = Object.fromEntries(cats.map((c) => [c, sum((w) => w.cats[c] ?? 0)]));
    const games = players.reduce((s, p) => s + (p.games_this_week ?? 0), 0);
    return {
      players,
      perGame: sum((w) => w.perGame),
      season: sum((w) => w.season),
      rest: sum((w) => w.rest),
      week: sum((w) => w.week),
      value: sum(pick),
      games,
      cats: catTotals,
    };
  };
  const giving = sideOf(give);
  const getting = sideOf(get);
  const net = getting.value - giving.value;
  const scale = Math.max(Math.abs(giving.value), Math.abs(getting.value), 1);
  const verdict = Math.abs(net) < 0.05 * scale ? 'even' : net > 0 ? 'you' : 'partner';
  const spots = getting.players.length - giving.players.length;

  // The manager's team before and after, with its rank in each category among the league's teams.
  const myRoster = hasRosters ? (setup.rosters[setup.mine] ?? []) : null;
  // Players on the injured list are owned but not playing: they stay out of a team's totals.
  const teamTotals = (roster: string[]) =>
    Object.fromEntries(cats.map((c) => [c, roster.filter((id) => !setup.il.includes(id)).reduce((s, id) => s + (worth.get(id)?.cats[c] ?? 0), 0)]));
  const change = (() => {
    if (!myRoster || points) return null;
    const after = (t: number) => {
      const roster = setup.rosters[t] ?? [];
      if (t === setup.mine) return [...roster.filter((id) => !give.includes(id)), ...get];
      if (t === partnerTeam) return [...roster.filter((id) => !get.includes(id)), ...give];
      return roster;
    };
    const before = setup.rosters.map((r) => teamTotals(r));
    const afterTotals = setup.rosters.map((_, t) => teamTotals(after(t)));
    const rankOf = (totals: Record<string, number>[], c: string) => {
      const order = totals
        .map((tot, t) => ({ t, v: tot[c] ?? 0, size: (setup.rosters[t] ?? []).length }))
        .filter((x) => x.size > 0 || x.t === setup.mine)
        .sort((a, b) => b.v - a.v);
      return order.findIndex((x) => x.t === setup.mine) + 1;
    };
    const ranked = setup.rosters.filter((r) => r.length > 0).length;
    return {
      ranked,
      rows: cats.map((c) => ({
        c,
        before: before[setup.mine]?.[c] ?? 0,
        after: afterTotals[setup.mine]?.[c] ?? 0,
        rankBefore: rankOf(before, c),
        rankAfter: rankOf(afterTotals, c),
      })),
    };
  })();

  // Suggestions: packages from the open side's roster that make the trade about even, ranked by the
  // category ranks they gain the manager; without rosters, players worth about the same as the target.
  const ready = giving.players.length > 0 || getting.players.length > 0;
  const restOf = new Map([...worth].map(([id, w]) => [id, pick(w)]));
  const active = (t: number) => (setup.rosters[t] ?? []).filter((id) => !setup.il.includes(id));
  const open = openSide(give, get, restOf);
  const suggestions =
    ready && hasRosters && partnerTeam >= 0
      ? suggestTrades({
          give,
          get,
          mine: active(setup.mine),
          theirs: active(partnerTeam),
          rest: restOf,
          cats: points ? [] : cats,
          catValue: (id) => worth.get(id)?.cats,
          totals: setup.rosters.map((r) => teamTotals(r)),
          myTeam: setup.mine,
          partnerTeam,
        })
      : [];
  const targetSide: Side = get.length ? 'get' : 'give';
  const nearest = ready && !hasRosters ? nearestInValue(targetSide === 'get' ? get : give, restOf, [...give, ...get]) : [];
  const nameOf = (id: string) => byId.get(id)?.full_name ?? id;
  const nameList = (ids: string[]) => ids.map(nameOf).join(' + ');
  const applySuggestion = (s: Suggestion) => {
    setGive(s.give);
    setGet(s.get);
  };
  /** The categories a suggestion moves your rank in, up and down. */
  const rankChanges = (s: Suggestion) =>
    s.ups.length || s.downs.length ? (
      <span className="whitespace-nowrap">
        {s.ups.length > 0 && <span className="text-good">↑ {s.ups.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}</span>}
        {s.ups.length > 0 && s.downs.length > 0 && ' '}
        {s.downs.length > 0 && <span className="text-bad">↓ {s.downs.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}</span>}
      </span>
    ) : (
      <span className="text-muted">no rank changes</span>
    );

  const add = (side: Side, id: string) => (side === 'give' ? setGive : setGet)((s) => (s.includes(id) ? s : [...s, id]));
  const remove = (side: Side, id: string) => (side === 'give' ? setGive : setGet)((s) => s.filter((x) => x !== id));
  const toggle = (side: Side, id: string, on: boolean) => (on ? add(side, id) : remove(side, id));

  const rosterPicker = (side: Side, team: number, picked: string[]) => {
    const roster = (setup.rosters[team] ?? [])
      .map((id) => byId.get(id))
      .filter((p): p is PlayerRow => !!p)
      .sort((a, b) => pick(worth.get(b.player_id) ?? NONE) - pick(worth.get(a.player_id) ?? NONE));
    if (!roster.length) return <p className="text-xs text-muted">No players on this roster yet: add them on the League page, or search below.</p>;
    return (
      <ul className="grid gap-0.5 text-sm" data-testid={`roster-${side}`}>
        {roster.map((p) => (
          <li key={p.player_id}>
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={picked.includes(p.player_id)} onChange={(e) => toggle(side, p.player_id, e.target.checked)} />
              <span className="min-w-0 flex-1 truncate">{p.full_name ?? p.player_id}</span>
              {setup.il.includes(p.player_id) && (
                <span className="rounded border border-warn px-1 text-[10px] font-semibold text-warn" title="On the injured list">
                  IL
                </span>
              )}
              <span className="text-xs text-muted">{p.position ?? '–'}</span>
              <span className="w-12 text-right tabular-nums"><Signed value={pick(worth.get(p.player_id) ?? NONE)} digits={1} /></span>
            </label>
          </li>
        ))}
      </ul>
    );
  };

  const sideCard = (side: Side, title: string, team: number | null, picked: string[]) => (
    <Card title={title} id={`trade-${side}`}>
      <div className="grid gap-3">
        {hasRosters && team !== null && team >= 0 && (
          <div>
            {side === 'get' ? (
              <label className="mb-2 flex items-center gap-2 text-sm">
                Trade partner{' '}
                <select value={team} onChange={(e) => setPartner(Number(e.target.value))} className={input} aria-label="Trade partner">
                  {setup.names.map((name, i) => (
                    i !== setup.mine && (
                      <option key={i} value={i}>
                        {name}
                      </option>
                    )
                  ))}
                </select>
              </label>
            ) : (
              <p className="mb-2 text-sm text-muted">
                Your team: <strong className="text-fg">{setup.names[team]}</strong>
              </p>
            )}
            {rosterPicker(side, team, picked)}
          </div>
        )}
        <PlayerPicker label={side === 'give' ? 'Add a player you give' : 'Add a player you get'} options={options} onAdd={(id) => add(side, id)} />
        {picked.length > 0 && (
          <ul className="flex flex-wrap gap-1" data-testid={`picked-${side}`}>
            {picked.map((id) => {
              const p = byId.get(id);
              return (
                <li key={id}>
                  <button type="button" className={`${button} flex items-center gap-1`} onClick={() => remove(side, id)} title="Remove from the trade">
                    {p?.full_name ?? id} <span aria-hidden="true">×</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );

  const playerRow = (p: PlayerRow) => {
    const w = worth.get(p.player_id);
    return (
      <tr key={p.player_id} className="border-t border-line">
        <Td pin="first">
          <span className="flex items-center gap-1 whitespace-nowrap">
            <a href={href(`/p/${league}/${p.player_id}/`)} className="underline-offset-4 hover:underline">
              {p.full_name ?? p.player_id}
            </a>
            <InjuryTag group={p.injury_group} status={p.injury_status} detail={injuryDetail(p)} />
          </span>
        </Td>
        <Td>{p.team_abbreviation ?? '–'}</Td>
        <Td>{p.position ?? '–'}</Td>
        {points && <Td right>{fmt(w?.fpts ?? null)}</Td>}
        <Td right>
          <Signed value={w?.perGame ?? 0} />
        </Td>
        <Td right>{pct(p.games_share)}</Td>
        <Td right>
          <Signed value={w?.season ?? 0} />
        </Td>
        {!complete && <Td right>{pct(p.ros_factor)}</Td>}
        {!complete && (
          <Td right>
            <Signed value={w?.rest ?? 0} />
          </Td>
        )}
        {weekAvailable && <Td right>{p.games_this_week ?? 0}</Td>}
        {weekAvailable && (
          <Td right>
            <Signed value={w?.week ?? 0} />
          </Td>
        )}
      </tr>
    );
  };

  const totalRow = (label: string, s: ReturnType<typeof sideOf>, testid: string) => (
    <tr className="border-t border-line font-semibold" data-testid={testid}>
      <Td>{label}</Td>
      <Td>{''}</Td>
      <Td>{s.players.length ? `${s.players.length} player${s.players.length === 1 ? '' : 's'}` : '–'}</Td>
      {points && <Td right>{''}</Td>}
      <Td right>
        <Signed value={s.perGame} />
      </Td>
      <Td right>{''}</Td>
      <Td right>
        <Signed value={s.season} />
      </Td>
      {!complete && <Td right>{''}</Td>}
      {!complete && (
        <Td right>
          <Signed value={s.rest} />
        </Td>
      )}
      {weekAvailable && <Td right>{s.games}</Td>}
      {weekAvailable && (
        <Td right>
          <Signed value={s.week} />
        </Td>
      )}
    </tr>
  );

  const rankTone = (before: number, after: number) => (after < before ? 'text-good' : after > before ? 'text-bad' : '');

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">

      {!hasRosters && (
        <p className="text-sm text-muted" data-testid="trade-no-league">
          {/* The same summary as the League bar, so it follows the settings (#453). */}
          Values are for {isDefaultSettings(setup, DEFAULT_SETTINGS[league]) ? 'the default league' : 'your settings'} (
          <span data-testid="trade-settings">{describeSettings(setup)}</span>). Set up your league&apos;s size, scoring and
          rosters on the <a href={href('/league/')} className="underline underline-offset-4">League page</a> to value a trade for your league and
          see your team before and after.
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        {sideCard('give', 'You give', hasRosters ? setup.mine : null, give)}
        {sideCard('get', 'You get', hasRosters ? partnerTeam : null, get)}
      </div>

      {ready && (
        <Card title="Verdict" id="verdict">
          {weekAvailable && (
            <div className="mb-2">
              <Segmented
                label="Value unit"
                value={week ? 'week' : 'rest'}
                options={[
                  { id: 'rest', label: 'Rest of season', title: 'Projected value over the games each player is expected to play from today' },
                  { id: 'week', label: 'This week', title: 'Last-ten form over the games left this fantasy week (Monday to Sunday)' },
                ]}
                onChange={setUnit}
              />
            </div>
          )}
          <div className="grid gap-2 text-sm" data-testid="trade-verdict">
            <p className="text-base">
              {verdict === 'even' ? (
                <>About even: the two sides are within 5% of each other for the {REST}.</>
              ) : verdict === 'you' ? (
                <>
                  Favours you by <Signed value={net} digits={1} /> for the {REST}.
                </>
              ) : (
                <>
                  Favours your partner by <Signed value={-net} digits={1} /> for the {REST}.
                </>
              )}
            </p>
            <p className="text-muted">
              You give <Signed value={giving.value} digits={1} /> and get <Signed value={getting.value} digits={1} />:{' '}
              {week ? (
                <>
                  each player&apos;s last-ten form above a replacement-level player under your league&apos;s scoring, counted over the games left
                  this fantasy week (Monday to Sunday).
                </>
              ) : (
                <>
                  value above a replacement-level player under your league&apos;s scoring, counted over the games each player is expected to play
                  from today (injuries, return dates and the schedule included). Over the whole season it is{' '}
                  <Signed value={giving.season} digits={1} /> for <Signed value={getting.season} digits={1} />.
                </>
              )}
            </p>
            {weekAvailable && (
              <p className="text-muted" data-testid="trade-week-games">
                Games left this fantasy week: {giving.games} for the players you give, {getting.games} for the players you get.
              </p>
            )}
            {spots !== 0 && (
              <p className="text-muted" data-testid="trade-spots">
                {spots > 0
                  ? `You receive ${spots} more player${spots === 1 ? '' : 's'} than you send, so you would drop ${spots}. A dropped player is worth about replacement level, which the values above already count as zero.`
                  : `You send ${-spots} more player${-spots === 1 ? '' : 's'} than you receive, freeing ${-spots} roster spot${-spots === 1 ? '' : 's'}. The best free agent fills each at about replacement level, so the values above already allow for it.`}
              </p>
            )}
            {points && (
              <p className="text-muted">Your league scores points: the values are fantasy points per game above replacement, with your league&apos;s weights.</p>
            )}
          </div>
        </Card>
      )}

      {ready && hasRosters && (
        <Card title="Suggested trades" id="suggestions">
          {suggestions.length ? (
            <>
              {/* A phone gets a stacked list, so each suggestion's button is on screen (#455); wider screens the table. */}
              <ul className="grid gap-2 text-sm md:hidden" data-testid="trade-suggestions-list">
                {suggestions.map((s) => (
                  <li key={`${s.give.join()}>${s.get.join()}`} className="grid gap-1 rounded border border-line p-2">
                    <p>
                      <span className="text-xs text-muted">You give </span>
                      {nameList(s.give)}
                    </p>
                    <p>
                      <span className="text-xs text-muted">You get </span>
                      {nameList(s.get)}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>
                        <span className="text-xs text-muted">Net </span>
                        <Signed value={s.net} digits={1} />
                      </span>
                      {!points && rankChanges(s)}
                    </p>
                    <button type="button" className={`${button} justify-self-start`} onClick={() => applySuggestion(s)}>
                      Use this trade
                    </button>
                  </li>
                ))}
              </ul>
              <div className="table-scroll hidden overflow-auto md:block" tabIndex={0} role="region" aria-label="Suggested trades">
                <table className="w-full text-sm" data-testid="trade-suggestions">
                  <thead>
                    <tr>
                      <Th>You give</Th>
                      <Th>You get</Th>
                      <Th right>Net</Th>
                      {!points && <Th>Your ranks</Th>}
                      <Th>{''}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {suggestions.map((s) => (
                      <tr key={`${s.give.join()}>${s.get.join()}`} className="border-t border-line">
                        <Td>{nameList(s.give)}</Td>
                        <Td>{nameList(s.get)}</Td>
                        <Td right>
                          <Signed value={s.net} digits={1} />
                        </Td>
                        {!points && <Td>{rankChanges(s)}</Td>}
                        <Td>
                          <button type="button" className={button} onClick={() => applySuggestion(s)}>
                            Use this trade
                          </button>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted" data-testid="trade-no-suggestions">
              {open === 'give' && !active(setup.mine).length
                ? 'Add your own roster on the League page to see what you could offer.'
                : open === 'get' && !active(partnerTeam).length
                  ? `Add ${setup.names[partnerTeam] ?? 'the partner'}’s roster on the League page to see what you could ask for.`
                  : `No package of up to three players from ${open === 'give' ? 'your' : `${setup.names[partnerTeam] ?? 'the partner'}’s`} roster comes within 15% of the other side for the ${REST}. Try another partner, or a different player.`}
            </p>
          )}
          <p className="mt-2 text-xs text-muted">
            {open === 'give' ? 'Packages from your roster' : `Packages from ${setup.names[partnerTeam] ?? 'the partner'}’s roster`} that bring the two sides within 15%
            of each other for the {REST}
            {points
              ? ', the ones that favour you most first.'
              : ', ranked by the category ranks your team gains (counting the partner’s side changing too), then by value. Pick one to load it into the trade and see the full breakdown.'}
          </p>
        </Card>
      )}

      {ready && !hasRosters && nearest.length > 0 && (
        <Card title="Players worth about the same" id="suggestions">
          <ul className="flex flex-wrap gap-1" data-testid="trade-nearest">
            {nearest.map(({ id, diff }) => (
              <li key={id}>
                <button type="button" className={`${button} flex items-center gap-1`} onClick={() => add(targetSide === 'get' ? 'give' : 'get', id)} title="Add to the trade">
                  {nameOf(id)} <Signed value={diff} digits={1} />
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            Players on the board worth about the same for the {REST} as {targetSide === 'get' ? 'what you get' : 'what you give'}, nearest first, with the
            difference. Tap one to put it on the other side. Set up your league&apos;s rosters to get packages from a partner&apos;s roster instead.
          </p>
        </Card>
      )}

      {ready && (
        <Card title="The players" id="players">
          <div className="table-scroll overflow-auto" tabIndex={0} role="region" aria-label="The players">
            <table className="w-full text-sm" data-testid="trade-players">
              <thead>
                <tr>
                  <Th>Player</Th>
                  <Th>Team</Th>
                  <Th>Pos</Th>
                  {points && <Th right>FPts/G</Th>}
                  <Th right>Value/G</Th>
                  <Th right>Games share</Th>
                  <Th right>{complete ? 'Next season' : 'Season'}</Th>
                  {!complete && <Th right>Available</Th>}
                  {!complete && <Th right>Rest of season</Th>}
                  {weekAvailable && <Th right>Games left</Th>}
                  {weekAvailable && <Th right>This week</Th>}
                </tr>
              </thead>
              <tbody>
                {giving.players.map(playerRow)}
                {totalRow('You give', giving, 'total-give')}
                {getting.players.map(playerRow)}
                {totalRow('You get', getting, 'total-get')}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">
            Value/G: value per game above your league&apos;s replacement level. Games share: the share of the season&apos;s games the player is projected to
            play.{' '}
            {complete
              ? 'The season is over: Next season counts those games under the projection.'
              : 'Available: the share of the remaining games the player is expected to play. Season and rest of season count those games.'}
          </p>
        </Card>
      )}

      {ready && !points && (
        <Card title={change ? 'Your team, category by category' : 'Category by category'} id="categories">
          <div className="table-scroll overflow-auto" tabIndex={0} role="region" aria-label="Category by category">
            <table className="w-full text-sm" data-testid="trade-categories">
              <thead>
                <tr>
                  <Th>Category</Th>
                  <Th right>You give</Th>
                  <Th right>You get</Th>
                  <Th right>Net</Th>
                  {change && <Th right>Your team before</Th>}
                  {change && <Th right>After</Th>}
                  {change && <Th right>Rank of {change.ranked}</Th>}
                </tr>
              </thead>
              <tbody>
                {cats.map((c) => {
                  const g = giving.cats[c] ?? 0;
                  const r = getting.cats[c] ?? 0;
                  const row = change?.rows.find((x) => x.c === c);
                  return (
                    <tr key={c} className="border-t border-line">
                      <Td>{CATEGORY_LABELS[c] ?? c}</Td>
                      <Td right>
                        <Signed value={g} />
                      </Td>
                      <Td right>
                        <Signed value={r} />
                      </Td>
                      <Td right>
                        <Signed value={r - g} />
                      </Td>
                      {row && (
                        <Td right>
                          <Signed value={row.before} digits={1} />
                        </Td>
                      )}
                      {row && (
                        <Td right>
                          <Signed value={row.after} digits={1} />
                        </Td>
                      )}
                      {row && (
                        <Td right>
                          <span className={rankTone(row.rankBefore, row.rankAfter)}>
                            {row.rankBefore}
                            {row.rankAfter !== row.rankBefore ? ` → ${row.rankAfter}` : ''}
                          </span>
                        </Td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">
            Per game above replacement in each category (percentages weighted by attempts).
            {change
              ? ' Your team’s totals and its rank among the league’s teams, before and after: a trade that drops a category you already lose costs little, and one that lifts a category you are close in can swing it.'
              : ' Set up your league’s rosters to see your team’s totals and ranks before and after.'}
          </p>
        </Card>
      )}
    </div>
  );
}
