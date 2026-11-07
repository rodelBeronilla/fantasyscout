/**
 * The League page: the manager's league (settings, teams in draft order, rosters), kept in this
 * browser; every other page reads it. With mode "draft" it is the Draft page instead (#716): the
 * snake draft, pick by pick, on the same league.
 */
import { useEffect, useMemo, useState } from 'react';

import { fetchBuildJson, type League } from '../lib/data';
import { CATEGORIES, fmt } from '../lib/format';
import { currentLeague, LEAGUE_LABEL } from '../lib/league';
import { assign, categoryWeights, DEFAULT_SETTINGS, draftPick, type LeagueSetup as Setup, matchNames, normalize, onTheClock, owners, toggleIl, undoPick, useLeague, weightedSum } from '../lib/fantasy-league';
import { categoryValues, pointValues, scaleValue } from '../lib/league-value';
import { applyYahooImport, parseYahooHash } from '../lib/yahoo-bookmarklet';
import { href } from '../lib/site';
import { auctionValues } from '../lib/auction';
import { DraftBar, LeagueSettingsForm, describeSettings } from './LeagueParts';
import { PlayerPicker } from './PlayerPicker';
import { Card, Loading, Problem } from './ui';
import AccountBox from './AccountBox';
import YahooImport from './YahooImport';
import EspnImport from './EspnImport';
import type { BoardColumn, ExportedRow } from '../generated/columns';

interface PlayerRowFields {
  player_id: string;
  season: string;
  full_name: string | null;
  position: string | null;
  team_abbreviation: string | null;
  games_share: number | null;
  injury_group: string | null;
  injury_status: string | null;
  expected_games_missed: number | null;
  expected_return: string | null;
  [key: string]: unknown;
}
// Only columns the export ships (export/layout.py): a field it does not ship fails the type check (#479).
type PlayerRow = ExportedRow<BoardColumn, PlayerRowFields>;

const input = 'rounded border border-line bg-bg px-2 py-1 text-sm';
const button = 'rounded border border-line px-2 py-1 text-xs hover:bg-bg disabled:opacity-50';

const optionLabel = (p: PlayerRow) => `${p.full_name ?? p.player_id} · ${p.team_abbreviation ?? 'FA'} · ${p.position ?? '–'}`;


function PasteNames({ teamName, players, onAdd }: { teamName: string; players: PlayerRow[]; onAdd: (ids: string[]) => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<string | null>(null);
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted">Paste a roster</summary>
      <div className="mt-2 grid gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          className={`${input} w-full font-mono text-xs`}
          aria-label={`Paste names for ${teamName}`}
          placeholder={'One player per line, as your league lists them'}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={button}
            disabled={!text.trim()}
            onClick={() => {
              const { matched, unmatched } = matchNames(text, players);
              onAdd(matched);
              setResult(`Added ${matched.length}.${unmatched.length ? ` Not found: ${unmatched.join(', ')}.` : ''}`);
              setText('');
            }}
          >
            Add pasted players
          </button>
          {result && (
            <span role="status" data-testid="paste-result">
              {result}
            </span>
          )}
        </div>
      </div>
    </details>
  );
}

export default function LeagueSetup({ mode = 'setup' }: { mode?: 'setup' | 'draft' }) {
  const [league] = useState<League>(() => currentLeague());
  const [rows, setRows] = useState<PlayerRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [setup, update] = useLeague(league);
  const [loadNote, setLoadNote] = useState<string | null>(null);
  // with every roster full, one team card is open at a time (#716); the manager's own to start
  const [openCard, setOpenCard] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    fetchBuildJson<PlayerRow[]>(`board/${league}.json`)
      .then((data) => live && setRows(data))
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, [league]);

  // A Yahoo bookmarklet lands here with the league in the fragment: import it once the board is in.
  useEffect(() => {
    if (!rows) return;
    const payload = parseYahooHash(window.location.hash);
    if (!payload) return;
    const result = applyYahooImport(setup, payload, rows);
    update(() => result.setup);
    setLoadNote(
      `Imported ${payload.teams.length} teams from Yahoo: ${result.matched} players matched` +
        (result.il ? `, ${result.il} on the IL` : '') +
        (result.unmatched.length ? `; not found: ${result.unmatched.join(', ')}` : '') +
        '.',
    );
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    // runs once, when the board arrives
  }, [rows]);

  const owner = useMemo(() => owners(setup), [setup]);
  const byId = useMemo(() => new Map((rows ?? []).map((r) => [r.player_id, r])), [rows]);
  const pool = setup.teams * setup.rosterSpots;
  const points = setup.scoring === 'points';
  const cats = useMemo(() => CATEGORIES.filter((c) => setup.scoring !== 'cats8' || c !== 'z_turnovers'), [setup.scoring]);
  // The draft list's value counts the league's punts out (#661).
  const catWeight = useMemo(() => categoryWeights({ ...setup, scoring: setup.scoring === 'points' ? 'cats9' : setup.scoring }), [setup]);
  const catValues = useMemo(() => (rows && !points ? categoryValues(rows, cats, pool, setup.teams) : null), [rows, points, cats, pool, setup.teams]);
  const pointVals = useMemo(() => (rows && points ? pointValues(rows, setup.weights, pool, setup.teams) : null), [rows, points, setup.weights, pool, setup.teams]);

  /** Value for the draft list: the board's value, per game above replacement times the share of games played. */
  const valueOf = useMemo(() => {
    const out = new Map<string, number>();
    for (const r of rows ?? []) {
      const perGame = points ? (pointVals?.get(r.player_id)?.value ?? 0) : weightedSum(catValues?.get(r.player_id), catWeight);
      out.set(r.player_id, scaleValue(perGame, r, { restOfSeason: false }));
    }
    return out;
  }, [rows, points, pointVals, catValues, catWeight]);

  // auction prices (#741) over the whole board's values, for a league this size
  const prices = useMemo(() => auctionValues(valueOf, { teams: setup.teams, rosterSpots: setup.rosterSpots }), [valueOf, setup.teams, setup.rosterSpots]);

  const available = useMemo(
    () => (rows ?? []).filter((r) => !owner.has(r.player_id)).sort((a, b) => (valueOf.get(b.player_id) ?? 0) - (valueOf.get(a.player_id) ?? 0)),
    [rows, owner, valueOf],
  );
  const options = useMemo(() => new Map(available.map((p) => [optionLabel(p), p.player_id])), [available]);

  if (error) return <Problem error={error} />;
  if (!rows) return <Loading what="the league" />;

  const rostered = owner.size;
  const lastPick = setup.picks.at(-1);

  const draftCard = (
    <Card title="Draft" id="draft">
      <div className="grid gap-3 text-sm" data-testid="draft-panel">
        {setup.drafting ? (
          <>
            <DraftBar
              setup={setup}
              lastName={lastPick ? (byId.get(lastPick.player)?.full_name ?? null) : null}
              onUndo={() => update(undoPick)}
              onEnd={() => update((s) => ({ ...s, drafting: false }))}
            />
            <div className="grid gap-3 md:grid-cols-2">
              <div className="grid content-start gap-2">
                <PlayerPicker label="Draft a player" options={options} onAdd={(id) => update((s) => draftPick(s, id))} />
                <p className="text-xs text-muted">
                  Best available by value.{' '}
                  <a href={href('/')} className="text-accent underline underline-offset-4">
                    Draft from the board
                  </a>{' '}
                  to see every column.
                </p>
                <ol className="grid gap-1" data-testid="best-available">
                  {available.slice(0, 8).map((p) => (
                    <li key={p.player_id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">
                        {p.full_name} <span className="text-xs text-muted">{p.position} {p.team_abbreviation}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="text-xs tabular-nums text-muted" title="Value, and the auction price for a league this size">
                          {fmt(valueOf.get(p.player_id) ?? null, 1)} · <span data-testid="draft-auction">${Math.round(prices.get(p.player_id) ?? 0)}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => update((s) => draftPick(s, p.player_id))}
                          className="rounded border border-accent px-1.5 text-xs text-accent hover:bg-accent hover:text-accent-fg"
                          aria-label={`Draft ${p.full_name ?? p.player_id}`}
                        >
                          Draft
                        </button>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="grid content-start gap-1">
                <h3 className="text-xs font-medium text-muted">Picks so far ({setup.picks.length})</h3>
                <ol className="grid max-h-72 gap-0.5 overflow-auto text-xs" data-testid="pick-log">
                  {[...setup.picks].reverse().map((p, i) => {
                    const n = setup.picks.length - i;
                    return (
                      <li key={`${n}-${p.player}`} className={p.team === setup.mine ? 'font-semibold' : ''}>
                        #{n} R{Math.floor((n - 1) / setup.teams) + 1} {setup.names[p.team]}: {byId.get(p.player)?.full_name ?? p.player}
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="text-muted">
              A snake draft: teams pick in the order listed, and the order reverses every round. Each pick goes to the team on the clock, here or on the
              board, and can be undone.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => update((s) => ({ ...s, drafting: true }))}
                className="rounded border border-accent bg-accent px-3 py-1 text-sm text-accent-fg"
              >
                {setup.picks.length ? `Continue the draft at pick ${onTheClock(setup).overall}` : 'Start a draft'}
              </button>
              {rostered > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm('Empty every roster and start a new draft?'))
                      update((s) => ({ ...s, rosters: s.rosters.map(() => []), picks: [], drafting: true }));
                  }}
                  className={button}
                >
                  Empty the rosters and start over
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );

  const download = () => {
    const blob = new Blob([JSON.stringify({ league, setup }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fantasyscout-${league}-league.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as { league?: string; setup?: Partial<Setup> };
      if (parsed.league !== league || !parsed.setup) throw new Error(`not a ${LEAGUE_LABEL[league]} league file`);
      const next = normalize(parsed.setup, DEFAULT_SETTINGS[league]);
      update(() => next);
      setLoadNote(`Loaded ${next.teams} teams and ${next.rosters.flat().length} rostered players.`);
    } catch (e) {
      setLoadNote(`Could not load that file: ${e instanceof Error ? e.message : String(e)}.`);
    }
  };

  if (mode === 'draft') {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <p className="text-sm text-muted" data-testid="league-bar">
          Drafting for <span data-testid="league-summary">{describeSettings(setup)}</span>, teams in the order on the{' '}
          <a href={href('/league/')} className="font-medium text-accent underline-offset-4 hover:underline">
            League page →
          </a>
        </p>
        {draftCard}
      </div>
    );
  }

  const yahoo = <YahooImport league={league} players={rows} hasRosters={rostered > 0} onImport={(next) => update(() => next)} />;
  // the setup a manager does once leads only until it is done: with rosters in, the import folds
  // to one line (#716); it keeps its place, so an import's result survives the switch
  const full = setup.rosters.every((r) => r.length >= setup.rosterSpots);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      {yahoo}
      {league === 'nba' && (
        <EspnImport season={rows[0]?.season ?? ''} players={rows} hasRosters={rostered > 0} onImport={(next) => update(() => next)} />
      )}

      <Card title="Settings" id="settings">
        <LeagueSettingsForm league={league} setup={setup} onChange={update} />
        <p className="mt-3 text-xs text-muted">
          Value on the board is measured against the players just outside a league this size: the {pool} best are rostered, so the next {setup.teams}{' '}
          set replacement level.
        </p>
      </Card>

      {setup.drafting && (
        <p className="rounded-lg border border-accent bg-card px-3 py-2 text-sm" data-testid="draft-link">
          A draft is under way:{' '}
          <a href={href('/draft/')} className="font-medium text-accent underline-offset-4 hover:underline">
            back to the draft room →
          </a>
        </p>
      )}

      {(setup.rosters[setup.mine] ?? []).length > 0 && !setup.drafting && (
        <p className="rounded-lg border border-line bg-card px-3 py-2 text-sm" data-testid="team-link">
          Your week, your categories against the league, injured-list moves and the swaps worth making are on{' '}
          <a href={href('/team/')} className="font-medium text-accent underline-offset-4 hover:underline">
            My Team →
          </a>
        </p>
      )}

      <section className="grid gap-3" aria-labelledby="teams-h">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="teams-h" className="text-sm font-medium tracking-wide text-muted uppercase">
            Teams and rosters
          </h2>
          <p className="text-xs text-muted">
            List teams in draft order. {rostered - setup.il.length} of {pool} roster spots filled
            {setup.il.length ? ` (${setup.il.length} more on the IL)` : ''}.
            <span className="ml-1" title="An injured-list slot (IL, IL+) holds a player without taking a roster spot: mark one with the IL button">
              IL players do not take a spot.
            </span>
          </p>
        </div>
        <div className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {setup.names.map((name, t) => {
            const roster = setup.rosters[t] ?? [];
            const mine = t === setup.mine;
            const folded = full && (openCard ?? setup.mine) !== t;
            if (folded) {
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setOpenCard(t)}
                  className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm hover:bg-card ${mine ? 'border-good' : 'border-line'}`}
                  data-testid="team-card-folded"
                  aria-label={`Show ${name}'s roster`}
                >
                  <span className="min-w-0 truncate font-medium">{name}</span>
                  <span className="text-xs whitespace-nowrap text-muted">
                    {mine ? 'My team · ' : ''}
                    {roster.length}/{setup.rosterSpots} ▾
                  </span>
                </button>
              );
            }
            return (
              <div
                key={t}
                className={`grid content-start gap-2 rounded-lg border p-3 ${mine ? 'border-good bg-card' : roster.length ? 'border-line bg-card' : 'border-dashed border-line'}`}
                data-testid="team-card"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={name}
                    onChange={(e) => {
                      const v = e.target.value;
                      update((s) => ({ ...s, names: s.names.map((n, i) => (i === t ? v : n)) }));
                    }}
                    className={`${input} min-w-0 flex-1 font-medium`}
                    aria-label={`Name of team ${t + 1}`}
                  />
                  <label className={`flex items-center gap-1 text-xs whitespace-nowrap ${mine ? 'font-semibold text-good' : 'text-muted'}`}>
                    <input type="radio" name="my-team" checked={mine} onChange={() => update((s) => ({ ...s, mine: t }))} aria-label={`${name} is my team`} />
                    My team
                  </label>
                </div>
                <p className={`text-xs ${roster.length > setup.rosterSpots ? 'text-bad' : 'text-muted'}`}>
                  {roster.length}/{setup.rosterSpots} players
                </p>
                {roster.length > 0 && (
                  <ul className="grid gap-0.5 text-sm" data-testid="roster">
                    {roster.map((id) => {
                      const p = byId.get(id);
                      return (
                        <li key={id} className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate">
                            <a href={href(`/p/${league}/${id}/`)} className="underline-offset-4 hover:underline">
                              {p?.full_name ?? id}
                            </a>{' '}
                            <span className="text-xs text-muted">
                              {p?.position ?? ''} {p?.team_abbreviation ?? ''}
                            </span>
                          </span>
                          <span className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => update((s) => toggleIl(s, id))}
                              aria-pressed={setup.il.includes(id)}
                              aria-label={`Injured list: ${p?.full_name ?? id}`}
                              title={setup.il.includes(id) ? 'On the injured list (IL): owned, not a roster spot. Click to move off it.' : 'Move to the injured list (IL): keeps the player but frees the roster spot'}
                              className={`rounded border px-1 text-[10px] font-semibold ${setup.il.includes(id) ? 'border-warn text-warn' : 'border-line text-muted hover:text-fg'}`}
                            >
                              IL
                            </button>
                            <button
                              type="button"
                              onClick={() => update((s) => assign(s, id, null))}
                              className="px-1 text-muted hover:text-bad"
                              aria-label={`Remove ${p?.full_name ?? id} from ${name}`}
                            >
                              ×
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <PlayerPicker label={`Add a player to ${name}`} options={options} onAdd={(id) => update((s) => assign(s, id, t))} />
                <PasteNames teamName={name} players={rows} onAdd={(ids) => update((s) => ids.reduce((acc, id) => assign(acc, id, t), s))} />
              </div>
            );
          })}
        </div>
      </section>

      <Card title="Your data" id="file">
        <AccountBox league={league} />
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm" data-testid="league-file">
          <button type="button" onClick={download} className={button}>
            Download the league file
          </button>
          <label className={`${button} cursor-pointer`}>
            Load a league file
            <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => void loadFile(e.target.files?.[0])} />
          </label>
          {rostered > 0 && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Empty every roster?')) update((s) => ({ ...s, rosters: s.rosters.map(() => []), picks: [], drafting: false }));
              }}
              className={button}
            >
              Empty every roster
            </button>
          )}
          {loadNote && <span role="status">{loadNote}</span>}
        </div>
        <p className="mt-2 text-xs text-muted">
          Signed out, the league lives in this browser only: the file moves it to another browser or device, and nothing is sent anywhere.
        </p>
      </Card>
    </div>
  );
}

