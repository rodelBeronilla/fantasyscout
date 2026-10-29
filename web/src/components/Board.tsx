import { useEffect, useMemo, useState } from 'react';

import { downloadCsv, toCsv } from '../lib/csv';
import { fetchBuildJson, type League } from '../lib/data';
import { CATEGORIES, CATEGORY_LABELS, day, fmt, pct } from '../lib/format';
import { currentLeague, LEAGUE_LABEL } from '../lib/league';
import { eligibleAt, POSITION_LETTERS, type PositionLetter, sortRows, type SortDir, toggle } from '../lib/players';
import { href } from '../lib/site';
import { useWatchlist } from '../lib/watchlist';
import { Chip, InjuryTag, Loading, NewTeam, Note, Problem, Signed, SortTh, Star, Td, Th } from './ui';

interface BoardRow {
  player_id: string;
  season: string;
  full_name: string | null;
  position: string | null;
  team_abbreviation: string | null;
  games_current: number | null;
  rank_total: number;
  value_total: number | null;
  value_rest_of_season: number | null;
  ros_factor: number | null;
  availability_multiplier: number | null;
  season_complete: boolean;
  games_remaining: number | null;
  games_next_7: number | null;
  injury_status: string | null;
  injury_group: string | null;
  injury_type: string | null;
  expected_return: string | null;
  injury_note: string | null;
  games_share: number | null;
  value_per_game: number | null;
  age: number | null;
  is_rookie: boolean | null;
  is_new_team: boolean | null;
  prev_team_abbreviation: string | null;
  proj_minutes_pg: number | null;
  [key: string]: unknown;
}

type View = 'value' | 'season' | 'last20' | 'recent' | 'projected' | 'pergame';

const VIEWS: { id: View; label: string; help: string }[] = [
  {
    id: 'value',
    label: 'Value',
    help: 'Category value per game above replacement from each player’s projected line, times the share of games they are projected to play; zero is a player you could pick up for free.',
  },
  { id: 'season', label: 'This season', help: 'Category z-scores over this season’s games.' },
  { id: 'last20', label: 'Last 20 games', help: 'Category z-scores over each player’s last twenty games this season.' },
  { id: 'recent', label: 'Last 10 games', help: 'Category z-scores over each player’s last ten games this season.' },
  {
    id: 'projected',
    label: 'Projected line',
    help: 'The per-game line the value is scored on: production per minute (seasons weighted by minutes played) times projected minutes, recent seasons counting more, starting from a replacement-level player.',
  },
  { id: 'pergame', label: 'Per game', help: 'This season’s per-game line; percentages are makes over attempts.' },
];

const LINE: { key: string; label: string; kind: 'num' | 'pct' }[] = [
  { key: 'minutes_pg', label: 'MIN', kind: 'num' },
  { key: 'points_pg', label: 'PTS', kind: 'num' },
  { key: 'rebounds_total_pg', label: 'REB', kind: 'num' },
  { key: 'assists_pg', label: 'AST', kind: 'num' },
  { key: 'steals_pg', label: 'STL', kind: 'num' },
  { key: 'blocks_pg', label: 'BLK', kind: 'num' },
  { key: 'three_pointers_made_pg', label: '3PM', kind: 'num' },
  { key: 'field_goal_pct', label: 'FG%', kind: 'pct' },
  { key: 'free_throw_pct', label: 'FT%', kind: 'pct' },
  { key: 'turnovers_pg', label: 'TO', kind: 'num' },
];

/** The columns of a line view: this season's line, or the projection's (proj_ prefix). */
function lineColumns(view: View): { key: string; label: string; kind: 'num' | 'pct' }[] {
  return LINE.map((c) => ({ ...c, key: view === 'projected' ? `proj_${c.key}` : c.key }));
}

const isLine = (view: View) => view === 'pergame' || view === 'projected';

const Z_PREFIX: Partial<Record<View, string>> = { season: 'season_', last20: 'last20_', recent: 'recent_' };

function zKey(view: View, category: string): string {
  return `${Z_PREFIX[view] ?? ''}${category}`;
}

type Availability = 'all' | 'no_out' | 'healthy';

const PAGE = 100;
const COMPARE_MAX = 4;

function num(row: BoardRow, key: string): number | null {
  const v = row[key];
  return typeof v === 'number' && !Number.isNaN(v) ? v : null;
}

export default function Board() {
  const [league] = useState<League>(() => currentLeague());
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [view, setView] = useState<View>('value');
  const [punts, setPunts] = useState<Set<string>>(new Set());
  const [restOfSeason, setRestOfSeason] = useState(false);
  const [countGames, setCountGames] = useState(true);
  const [team, setTeam] = useState('');
  const [positions, setPositions] = useState<Set<PositionLetter>>(new Set());
  const [minGames, setMinGames] = useState(0);
  const [minMinutes, setMinMinutes] = useState(0);
  const [availability, setAvailability] = useState<Availability>('all');
  const [rookiesOnly, setRookiesOnly] = useState(false);
  const [movedOnly, setMovedOnly] = useState(false);
  const [watchOnly, setWatchOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState('value');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [shown, setShown] = useState(PAGE);
  const [compare, setCompare] = useState<string[]>([]);
  const { watched, toggleWatched } = useWatchlist(league);

  useEffect(() => {
    let live = true;
    fetchBuildJson<BoardRow[]>(`board/${league}.json`)
      .then((data) => live && setRows(data))
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, [league]);

  const meta = useMemo(() => {
    const list = rows ?? [];
    const season = list[0]?.season ?? '';
    const complete = list.length > 0 && list.every((r) => r.season_complete);
    const maxGames = list.reduce((m, r) => Math.max(m, r.games_current ?? 0), 0);
    const remaining = list.reduce((m, r) => Math.max(m, r.games_remaining ?? 0), 0);
    const teams = [...new Set(list.map((r) => r.team_abbreviation).filter((t): t is string => !!t))].sort();
    const injured = list.filter((r) => r.injury_group).length;
    return { season, complete, maxGames, remaining, teams, injured };
  }, [rows]);

  const scored = useMemo(() => {
    if (!rows) return [];
    const active = CATEGORIES.filter((c) => !punts.has(c));
    return rows.map((r) => {
      let value: number | null;
      if (isLine(view)) {
        value = num(r, view === 'projected' ? 'proj_points_pg' : 'points_pg');
      } else {
        const parts = active.map((c) => num(r, zKey(view, c)));
        value = parts.every((p) => p === null) ? null : parts.reduce<number>((s, p) => s + (p ?? 0), 0);
        // Only value above replacement scales: a game missed by a player not worth rostering costs nothing.
        if (value !== null && value > 0 && view === 'value') {
          if (countGames) value *= r.games_share ?? 1;
          if (restOfSeason && !r.season_complete) value *= r.ros_factor ?? 1;
        }
      }
      return { row: r, value };
    });
  }, [rows, view, punts, restOfSeason, countGames]);

  const ranked = useMemo(() => {
    const q = query.toLowerCase();
    const filtered = scored
      .filter(({ row }) => !team || row.team_abbreviation === team)
      .filter(({ row }) => eligibleAt(row.position, positions))
      .filter(({ row }) => (row.games_current ?? 0) >= minGames)
      .filter(({ row }) => (row.proj_minutes_pg ?? 0) >= minMinutes)
      .filter(({ row }) => availability === 'all' || (availability === 'no_out' ? row.injury_group !== 'out' : !row.injury_group))
      .filter(({ row }) => !rookiesOnly || row.is_rookie === true)
      .filter(({ row }) => !movedOnly || row.is_new_team === true)
      .filter(({ row }) => !watchOnly || watched.has(row.player_id))
      .filter(({ row }) => !q || (row.full_name ?? '').toLowerCase().includes(q))
      .filter(({ value }) => view === 'value' || value !== null);
    const get = (s: (typeof filtered)[number]): number | string | null => {
      if (sortKey === 'value') return s.value;
      if (sortKey === 'name') return s.row.full_name;
      if (sortKey === 'team') return s.row.team_abbreviation;
      if (sortKey === 'pos') return s.row.position;
      return num(s.row, sortKey);
    };
    return sortRows(filtered, get, sortDir);
  }, [scored, team, positions, minGames, minMinutes, availability, rookiesOnly, movedOnly, watchOnly, watched, query, sortKey, sortDir, view]);

  if (error) return <Problem error={error} />;
  if (!rows) return <Loading what="the board" />;

  const sortBy = (key: string, defaultDir: SortDir = 'desc') => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      setSortDir(defaultDir);
    }
  };
  const resetSort = (v: View) => {
    setView(v);
    setSortKey('value');
    setSortDir('desc');
  };
  const eightCat = punts.has('z_turnovers');
  const setFormat = (eight: boolean) => {
    const next = new Set(punts);
    if (eight) next.add('z_turnovers');
    else next.delete('z_turnovers');
    setPunts(next);
  };
  const toggleCompare = (id: string) =>
    setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= COMPARE_MAX ? c : [...c, id]));
  const showNext7 = !meta.complete;
  const categoryColumns = isLine(view)
    ? lineColumns(view).map((c) => ({ key: c.key, label: c.label, kind: c.kind as 'num' | 'pct' | 'z' }))
    : CATEGORIES.map((c) => ({ key: zKey(view, c), label: CATEGORY_LABELS[c] ?? c, category: c, kind: 'z' as const }));
  const byId = new Map(rows.map((r) => [r.player_id, r]));
  const compared = compare.map((id) => byId.get(id)).filter((r): r is BoardRow => !!r);
  const valueOf = new Map(scored.map((s) => [s.row.player_id, s.value]));

  const exportCsv = () => {
    const header = ['rank', 'player', 'team', 'position', 'age', 'rookie', 'new_team_from', 'games', 'games_share', ...categoryColumns.map((c) => c.label)];
    if (!isLine(view)) header.push('total');
    const body = ranked.map(({ row, value }, i) => {
      const cells: (string | number | boolean | null)[] = [
        i + 1,
        row.full_name,
        row.team_abbreviation,
        row.position,
        row.age,
        row.is_rookie,
        row.is_new_team ? row.prev_team_abbreviation : null,
        row.games_current,
        row.games_share,
        ...categoryColumns.map((c) => ('category' in c && punts.has(c.category as string) ? null : num(row, c.key))),
      ];
      if (!isLine(view)) cells.push(value);
      return cells;
    });
    downloadCsv(`fantasyscout-${league}-board-${view}.csv`, toCsv(header, body));
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      {meta.complete ? (
        <Note testid="season-note">
          The {LEAGUE_LABEL[league]} {meta.season} regular season is over. Values project next season from this one and
          the two before it, for players on a current roster; rest-of-season ranking returns when the next schedule is
          out.
        </Note>
      ) : (
        <Note testid="season-note">
          {LEAGUE_LABEL[league]} {meta.season}: up to {meta.maxGames} game{meta.maxGames === 1 ? '' : 's'} played and up to{' '}
          {meta.remaining} left per team.
          {meta.maxGames < 20 ? ' Projections count this season by games played, so a few games move a value only a little.' : ''}
          {meta.injured ? ` ${meta.injured} players are on the current injury report.` : ''}
        </Note>
      )}

      <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Value view">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="radio"
            aria-checked={view === v.id}
            title={v.help}
            onClick={() => resetSort(v.id)}
            className={`rounded-full border px-3 py-1 text-sm ${view === v.id ? 'border-accent bg-accent text-accent-fg' : 'border-line'}`}
          >
            {v.label}
          </button>
        ))}
        <span className="text-xs text-muted">{VIEWS.find((v) => v.id === view)?.help}</span>
      </div>

      {!isLine(view) && (
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Format and punts (drop from the total)</legend>
          <label className="text-sm">
            <span className="sr-only">League format</span>
            <select
              value={eightCat ? '8' : '9'}
              onChange={(e) => setFormat(e.target.value === '8')}
              className="rounded border border-line bg-card px-2 py-1"
            >
              <option value="9">9-cat</option>
              <option value="8">8-cat (no TO)</option>
            </select>
          </label>
          {CATEGORIES.map((c) => (
            <Chip key={c} checked={punts.has(c)} strike onChange={() => setPunts(toggle(punts, c))}>
              {CATEGORY_LABELS[c]}
            </Chip>
          ))}
          {view === 'value' && (
            <label className="ml-2 flex items-center gap-2 text-sm" title="Multiply value per game by the projected share of team games played">
              <input type="checkbox" checked={countGames} onChange={(e) => setCountGames(e.target.checked)} />
              Count games played
            </label>
          )}
          {view === 'value' && (
            <label className={`ml-2 flex items-center gap-2 text-sm ${meta.complete ? 'text-muted' : ''}`}>
              <input
                type="checkbox"
                checked={restOfSeason && !meta.complete}
                disabled={meta.complete}
                onChange={(e) => setRestOfSeason(e.target.checked)}
              />
              Rest of season (value above replacement × games left × availability)
            </label>
          )}
        </fieldset>
      )}

      <div className="flex flex-wrap items-center gap-3" data-testid="board-filters">
        <label className="text-sm">
          <span className="sr-only">Search player</span>
          <input
            type="search"
            placeholder="Search player"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="rounded border border-line bg-card px-2 py-1"
          />
        </label>
        <label className="text-sm">
          <span className="sr-only">Team</span>
          <select value={team} onChange={(e) => setTeam(e.target.value)} className="rounded border border-line bg-card px-2 py-1">
            <option value="">All teams</option>
            {meta.teams.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1" role="group" aria-label="Position">
          {POSITION_LETTERS.map((p) => (
            <Chip key={p} label={`Position ${p}`} checked={positions.has(p)} onChange={() => setPositions(toggle(positions, p))}>
              {p}
            </Chip>
          ))}
        </div>
        <label className="text-sm">
          Min games{' '}
          <select value={minGames} onChange={(e) => setMinGames(Number(e.target.value))} className="rounded border border-line bg-card px-2 py-1">
            {[0, 5, 10, 20].map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm" title="Projected minutes per game">
          Min MPG{' '}
          <select value={minMinutes} onChange={(e) => setMinMinutes(Number(e.target.value))} className="rounded border border-line bg-card px-2 py-1">
            {[0, 15, 20, 25, 30].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="sr-only">Availability</span>
          <select
            value={availability}
            onChange={(e) => setAvailability(e.target.value as Availability)}
            className="rounded border border-line bg-card px-2 py-1"
          >
            <option value="all">Everyone</option>
            <option value="no_out">Hide players ruled out</option>
            <option value="healthy">Healthy only</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={rookiesOnly} onChange={(e) => setRookiesOnly(e.target.checked)} />
          Rookies only
        </label>
        <label className="flex items-center gap-2 text-sm" title="Players whose current team differs from last season's">
          <input type="checkbox" checked={movedOnly} onChange={(e) => setMovedOnly(e.target.checked)} />
          Changed teams
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={watchOnly} onChange={(e) => setWatchOnly(e.target.checked)} />
          Watchlist only ({watched.size})
        </label>
        <span className="text-sm text-muted">{ranked.length} players</span>
        <button type="button" onClick={exportCsv} className="rounded border border-line px-3 py-1 text-sm hover:bg-card" data-testid="board-csv">
          Export CSV
        </button>
      </div>

      {compared.length > 0 && (
        <section className="min-w-0 rounded-lg border border-line bg-card p-3" aria-labelledby="compare-h" data-testid="compare">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="compare-h" className="text-sm font-medium tracking-wide text-muted uppercase">
              Compare ({compared.length}/{COMPARE_MAX})
            </h2>
            <button type="button" onClick={() => setCompare([])} className="rounded border border-line px-2 py-0.5 text-xs hover:bg-bg">
              Clear
            </button>
          </div>
          <div className="table-scroll mt-2 max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="Player comparison">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th>{isLine(view) ? 'Value view' : (VIEWS.find((v) => v.id === view)?.label ?? '')}</Th>
                  {compared.map((r) => (
                    <Th key={r.player_id} right>
                      {r.full_name}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...CATEGORIES.map((c) => ({ label: CATEGORY_LABELS[c] ?? c, get: (r: BoardRow) => (punts.has(c) ? null : num(r, zKey(isLine(view) ? 'value' : view, c))), kind: 'z' })),
                  { label: 'Total', get: (r: BoardRow) => (isLine(view) ? r.value_total : (valueOf.get(r.player_id) ?? null)), kind: 'z' },
                  { label: 'GP%', get: (r: BoardRow) => r.games_share, kind: 'pct' },
                  ...LINE.map((l) => ({ label: `${l.label} (proj)`, get: (r: BoardRow) => num(r, `proj_${l.key}`), kind: l.kind })),
                ].map((m) => {
                  const values = compared.map((r) => m.get(r));
                  const better = m.label.startsWith('TO (') ? Math.min : Math.max;
                  const known = values.filter((v): v is number => typeof v === 'number');
                  const best = known.length > 1 ? better(...known) : null;
                  return (
                    <tr key={m.label} className="border-t border-line">
                      <Td>{m.label}</Td>
                      {values.map((v, i) => (
                        <Td key={compared[i]?.player_id} right>
                          <span className={best !== null && v === best ? 'font-semibold' : ''}>
                            {m.kind === 'z' ? <Signed value={v} /> : m.kind === 'pct' ? pct(v) : fmt(v)}
                          </span>
                        </Td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="table-scroll max-h-[70vh] overflow-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="Scrollable table">
        <table className="w-full text-sm" data-testid="board">
          <thead className="bg-card">
            <tr>
              <Th right>#</Th>
              <SortTh active={sortKey === 'name'} dir={sortDir} onClick={() => sortBy('name', 'asc')}>
                Player
              </SortTh>
              <SortTh active={sortKey === 'team'} dir={sortDir} onClick={() => sortBy('team', 'asc')}>
                Team
              </SortTh>
              <SortTh active={sortKey === 'pos'} dir={sortDir} onClick={() => sortBy('pos', 'asc')}>
                Pos
              </SortTh>
              <SortTh right active={sortKey === 'age'} dir={sortDir} onClick={() => sortBy('age', 'asc')}>
                Age
              </SortTh>
              <SortTh right active={sortKey === 'games_current'} dir={sortDir} onClick={() => sortBy('games_current')} title="Games this season">
                GP
              </SortTh>
              {view === 'value' && (
                <SortTh right active={sortKey === 'games_share'} dir={sortDir} onClick={() => sortBy('games_share')} title="Projected share of team games played">
                  GP%
                </SortTh>
              )}
              {showNext7 && (
                <SortTh right active={sortKey === 'games_next_7'} dir={sortDir} onClick={() => sortBy('games_next_7')} title="Team games in the next 7 days">
                  Next 7
                </SortTh>
              )}
              {categoryColumns.map((c) => {
                const punted = 'category' in c && punts.has(c.category as string);
                return (
                  <SortTh key={c.key} right active={sortKey === c.key} dir={sortDir} onClick={() => sortBy(c.key, c.label === 'TO' && isLine(view) ? 'asc' : 'desc')}>
                    {punted ? <s>{c.label}</s> : c.label}
                  </SortTh>
                );
              })}
              {!isLine(view) && (
                <SortTh right active={sortKey === 'value'} dir={sortDir} onClick={() => sortBy('value')}>
                  Total
                </SortTh>
              )}
              <Th>
                <span title={`Pick up to ${COMPARE_MAX} players to compare`}>Cmp</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {ranked.slice(0, shown).map(({ row, value }, i) => (
              <tr key={row.player_id} className="border-t border-line">
                <Td right>{i + 1}</Td>
                <Td>
                  <span className="flex items-center gap-1 whitespace-nowrap">
                    <Star on={watched.has(row.player_id)} label={row.full_name ?? row.player_id} onToggle={() => toggleWatched(row.player_id)} />
                    <a href={href(`/p/${league}/${row.player_id}/`)} className="underline-offset-4 hover:underline">
                      {row.full_name ?? row.player_id}
                    </a>
                    {row.is_rookie && (
                      <span className="rounded border border-line px-1 text-[10px] text-muted" title="Rookie">
                        R
                      </span>
                    )}
                    {row.is_new_team && <NewTeam from={row.prev_team_abbreviation} />}
                    <InjuryTag
                      group={row.injury_group}
                      status={row.injury_status}
                      detail={[row.injury_type, row.expected_return ? `return ${day(row.expected_return)}` : null, row.injury_note]
                        .filter(Boolean)
                        .join(' · ')}
                    />
                  </span>
                </Td>
                <Td>{row.team_abbreviation ?? '–'}</Td>
                <Td>{row.position ?? '–'}</Td>
                <Td right>{row.age ?? '–'}</Td>
                <Td right>{row.games_current ?? 0}</Td>
                {view === 'value' && <Td right>{pct(row.games_share)}</Td>}
                {showNext7 && <Td right>{row.games_next_7 ?? 0}</Td>}
                {isLine(view)
                  ? lineColumns(view).map((c) => (
                      <Td key={c.key} right>
                        {c.kind === 'pct' ? pct(num(row, c.key)) : fmt(num(row, c.key))}
                      </Td>
                    ))
                  : CATEGORIES.map((c) => (
                      <Td key={c} right>
                        <Signed value={punts.has(c) ? null : num(row, zKey(view, c))} />
                      </Td>
                    ))}
                {!isLine(view) && (
                  <Td right>
                    <strong>{fmt(value, 2)}</strong>
                  </Td>
                )}
                <Td>
                  <input
                    type="checkbox"
                    aria-label={`Compare ${row.full_name ?? row.player_id}`}
                    checked={compare.includes(row.player_id)}
                    disabled={!compare.includes(row.player_id) && compare.length >= COMPARE_MAX}
                    onChange={() => toggleCompare(row.player_id)}
                  />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ranked.length > shown && (
        <button
          type="button"
          onClick={() => setShown(shown + PAGE)}
          className="justify-self-start rounded border border-line px-3 py-1 text-sm hover:bg-card"
          data-testid="board-more"
        >
          Show {Math.min(PAGE, ranked.length - shown)} more
        </button>
      )}
    </div>
  );
}
