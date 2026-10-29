/**
 * The League page: the manager's league (settings, teams in draft order, rosters), a snake draft,
 * and how the teams stand. Kept in this browser; the board and Streamers read it.
 */
import { type ChangeEvent, useEffect, useMemo, useState } from 'react';

import { fetchBuildJson, type League } from '../lib/data';
import { CATEGORIES, CATEGORY_LABELS, fmt } from '../lib/format';
import { currentLeague, LEAGUE_LABEL } from '../lib/league';
import { assign, DEFAULT_SETTINGS, draftPick, type LeagueSetup as Setup, matchNames, normalize, onTheClock, owners, undoPick, useLeague } from '../lib/fantasy-league';
import { categoryValues, pointValues } from '../lib/league-value';
import { href } from '../lib/site';
import { CategoryProfile, DraftBar, LeagueSettingsForm } from './LeagueParts';
import { Card, Loading, Problem, Td, Th } from './ui';

interface PlayerRow {
  player_id: string;
  full_name: string | null;
  position: string | null;
  team_abbreviation: string | null;
  games_share: number | null;
  [key: string]: unknown;
}

const input = 'rounded border border-line bg-bg px-2 py-1 text-sm';
const button = 'rounded border border-line px-2 py-1 text-xs hover:bg-bg disabled:opacity-50';

const optionLabel = (p: PlayerRow) => `${p.full_name ?? p.player_id} · ${p.team_abbreviation ?? 'FA'} · ${p.position ?? '–'}`;

/** Type a name and pick it from the list to add the player. */
function AddPlayer({ label, options, onAdd }: { label: string; options: Map<string, string>; onAdd: (id: string) => void }) {
  const [text, setText] = useState('');
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const id = options.get(e.target.value);
    if (id) {
      onAdd(id);
      setText('');
    } else setText(e.target.value);
  };
  return (
    <input
      type="search"
      list="league-players"
      value={text}
      onChange={onChange}
      placeholder="Add a player"
      aria-label={label}
      className={`${input} w-full`}
    />
  );
}

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

export default function LeagueSetup() {
  const [league] = useState<League>(() => currentLeague());
  const [rows, setRows] = useState<PlayerRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [setup, update] = useLeague(league);
  const [loadNote, setLoadNote] = useState<string | null>(null);

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
  const byId = useMemo(() => new Map((rows ?? []).map((r) => [r.player_id, r])), [rows]);
  const pool = setup.teams * setup.rosterSpots;
  const points = setup.scoring === 'points';
  const cats = useMemo(() => CATEGORIES.filter((c) => setup.scoring !== 'cats8' || c !== 'z_turnovers'), [setup.scoring]);
  const catValues = useMemo(() => (rows && !points ? categoryValues(rows, cats, pool, setup.teams) : null), [rows, points, cats, pool, setup.teams]);
  const pointVals = useMemo(() => (rows && points ? pointValues(rows, setup.weights, pool, setup.teams) : null), [rows, points, setup.weights, pool, setup.teams]);

  /** Value for the draft list: the board's value, per game above replacement times the share of games played. */
  const valueOf = useMemo(() => {
    const out = new Map<string, number>();
    for (const r of rows ?? []) {
      const perGame = points ? (pointVals?.get(r.player_id)?.value ?? 0) : cats.reduce((s, c) => s + (catValues?.get(r.player_id)?.[c] ?? 0), 0);
      out.set(r.player_id, perGame > 0 ? perGame * (r.games_share ?? 1) : perGame);
    }
    return out;
  }, [rows, points, pointVals, catValues, cats]);

  const available = useMemo(
    () => (rows ?? []).filter((r) => !owner.has(r.player_id)).sort((a, b) => (valueOf.get(b.player_id) ?? 0) - (valueOf.get(a.player_id) ?? 0)),
    [rows, owner, valueOf],
  );
  const options = useMemo(() => new Map(available.map((p) => [optionLabel(p), p.player_id])), [available]);

  // Each team's total in every category (per game, above replacement), and its rank in each.
  const strength = useMemo(() => {
    if (!rows) return null;
    const teams = setup.rosters.map((roster, t) => {
      const totals: Record<string, number> = {};
      if (catValues) for (const c of cats) totals[c] = roster.reduce((s, id) => s + (catValues.get(id)?.[c] ?? 0), 0);
      const fpts = pointVals ? roster.reduce((s, id) => s + (pointVals.get(id)?.fpts ?? 0), 0) : 0;
      const total = catValues ? cats.reduce((s, c) => s + (totals[c] ?? 0), 0) : fpts;
      return { team: t, totals, fpts, total, size: roster.length };
    });
    // Only teams with players are ranked against each other.
    const rankIn = (get: (x: (typeof teams)[number]) => number) => {
      const order = teams.filter((x) => x.size > 0).sort((a, b) => get(b) - get(a)).map((x) => x.team);
      return new Map(order.map((t, i) => [t, i + 1]));
    };
    const ranks = Object.fromEntries(cats.map((c) => [c, rankIn((x) => x.totals[c] ?? 0)]));
    return { teams, ranks, totalRank: rankIn((x) => x.total), ranked: teams.filter((x) => x.size > 0).length };
  }, [rows, setup.rosters, catValues, pointVals, cats]);

  if (error) return <Problem error={error} />;
  if (!rows) return <Loading what="the league" />;

  const rostered = owner.size;
  const mineTotals = strength?.teams[setup.mine]?.totals ?? {};
  const weakest = Object.entries(mineTotals)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .map(([c]) => c);
  const lastPick = setup.picks.at(-1);
  const ranked = strength?.ranked ?? 0;
  const third = Math.max(1, Math.round(ranked / 3));
  const rankTone = (rank: number | undefined) =>
    rank === undefined || ranked < 3 ? '' : rank <= third ? 'text-good' : rank > ranked - third ? 'text-bad' : '';

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
                <AddPlayer label="Draft a player" options={options} onAdd={(id) => update((s) => draftPick(s, id))} />
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
                        <span className="text-xs tabular-nums text-muted">{fmt(valueOf.get(p.player_id) ?? null, 1)}</span>
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
                {setup.picks.length ? `Resume the draft at pick ${onTheClock(setup).overall}` : 'Start a draft'}
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

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <datalist id="league-players">
        {[...options.keys()].map((label) => (
          <option key={label} value={label} />
        ))}
      </datalist>

      <Card title="Settings" id="settings">
        <LeagueSettingsForm league={league} setup={setup} onChange={update} />
        <p className="mt-3 text-xs text-muted">
          Value on the board is measured against the players just outside a league this size: the {pool} best are rostered, so the next {setup.teams}{' '}
          set replacement level.
        </p>
      </Card>

      {setup.drafting && draftCard}

      <section className="grid gap-3" aria-labelledby="teams-h">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="teams-h" className="text-sm font-medium tracking-wide text-muted uppercase">
            Teams and rosters
          </h2>
          <p className="text-xs text-muted">
            List teams in draft order. {rostered} of {pool} roster spots filled.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {setup.names.map((name, t) => {
            const roster = setup.rosters[t] ?? [];
            const mine = t === setup.mine;
            return (
              <div key={t} className={`grid content-start gap-2 rounded-lg border bg-card p-3 ${mine ? 'border-good' : 'border-line'}`} data-testid="team-card">
                <div className="flex items-center gap-2">
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
                          <button
                            type="button"
                            onClick={() => update((s) => assign(s, id, null))}
                            className="px-1 text-muted hover:text-bad"
                            aria-label={`Remove ${p?.full_name ?? id} from ${name}`}
                          >
                            ×
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <AddPlayer label={`Add a player to ${name}`} options={options} onAdd={(id) => update((s) => assign(s, id, t))} />
                <PasteNames teamName={name} players={rows} onAdd={(ids) => update((s) => ids.reduce((acc, id) => assign(acc, id, t), s))} />
              </div>
            );
          })}
        </div>
      </section>

      {!setup.drafting && draftCard}

      {strength && rostered > 0 && (
        <Card title="Team strength" id="strength">
          <p className="mb-2 text-xs text-muted">
            {points
              ? 'Each team’s projected fantasy points a game, from the players on its roster.'
              : 'Each team’s value per game above replacement in every category, summed over its roster. Green is the top third of the teams with players, red the bottom third.'}
          </p>
          <div className="table-scroll max-h-[70vh] overflow-auto rounded border border-line" tabIndex={0} role="region" aria-label="Team strength">
            <table className="w-full text-sm" data-testid="team-strength">
              <thead>
                <tr>
                  <Th>Team</Th>
                  <Th right>Players</Th>
                  {!points && cats.map((c) => <Th key={c} right>{CATEGORY_LABELS[c] ?? c}</Th>)}
                  <Th right>{points ? 'FPts/G' : 'Total'}</Th>
                </tr>
              </thead>
              <tbody>
                {strength.teams.map((x) => (
                  <tr key={x.team} className={`border-t border-line ${x.team === setup.mine ? 'font-semibold' : ''}`}>
                    <Td>{setup.names[x.team]}</Td>
                    <Td right>{x.size}</Td>
                    {!points &&
                      cats.map((c) => {
                        const rank = strength.ranks[c]?.get(x.team);
                        return (
                          <Td key={c} right>
                            <span className={rankTone(rank)} title={rank ? `Rank ${rank} of ${ranked}` : undefined}>
                              {x.size ? fmt(x.totals[c] ?? 0, 1) : '–'}
                            </span>
                          </Td>
                        );
                      })}
                    <Td right>
                      <span className={rankTone(strength.totalRank.get(x.team))}>{x.size ? fmt(x.total, 1) : '–'}</span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!points && (setup.rosters[setup.mine] ?? []).length > 0 && (
            <div className="mt-3 grid gap-1 text-xs">
              <p className="text-muted">
                {setup.names[setup.mine]}: weakest in <strong className="text-fg">{weakest.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}</strong>. The
                board&apos;s Fit column ranks players by how much they add there.
              </p>
              <CategoryProfile totals={mineTotals} weakest={weakest} />
            </div>
          )}
        </Card>
      )}

      <Card title="Save and load" id="file">
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="league-file">
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
          The league lives in this browser only. The file moves it to another browser or device; nothing is sent anywhere.
        </p>
      </Card>
    </div>
  );
}

