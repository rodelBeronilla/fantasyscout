import { useEffect, useMemo, useState } from 'react';

import { fetchBuildJson, type League } from '../lib/data';
import { CATEGORIES, CATEGORY_LABELS, day, fmt, pct } from '../lib/format';
import { currentLeague, LEAGUE_LABEL } from '../lib/league';
import { eligibleAt, POSITION_LETTERS, type PositionLetter, sortRows, type SortDir, toggle } from '../lib/players';
import { href } from '../lib/site';
import { Chip, InjuryTag, Loading, Note, Problem, Signed, SortTh, Td, Th } from './ui';

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
  availability_multiplier: number | null;
  season_complete: boolean;
  games_remaining: number | null;
  games_next_7: number | null;
  injury_status: string | null;
  injury_group: string | null;
  injury_type: string | null;
  expected_return: string | null;
  injury_note: string | null;
  minutes_pg: number | null;
  points_pg: number | null;
  rebounds_total_pg: number | null;
  assists_pg: number | null;
  steals_pg: number | null;
  blocks_pg: number | null;
  three_pointers_made_pg: number | null;
  turnovers_pg: number | null;
  field_goal_pct: number | null;
  free_throw_pct: number | null;
  [key: string]: unknown;
}

type View = 'blend' | 'recent' | 'pergame';

const VIEWS: { id: View; label: string; help: string }[] = [
  {
    id: 'blend',
    label: 'Blended value',
    help: 'Category z-scores blended across this season and the two before; this season counts for more as games accumulate.',
  },
  { id: 'recent', label: 'Last 10 games', help: 'Category z-scores over each player’s last ten games this season.' },
  { id: 'pergame', label: 'Per game', help: 'This season’s per-game line; percentages are makes over attempts.' },
];

const PER_GAME: { key: keyof BoardRow; label: string; kind: 'num' | 'pct' }[] = [
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

const PAGE = 100;

function num(row: BoardRow, key: string): number | null {
  const v = row[key];
  return typeof v === 'number' && !Number.isNaN(v) ? v : null;
}

function zKey(view: View, category: string): string {
  return view === 'recent' ? `recent_${category}` : category;
}

export default function Board() {
  const [league] = useState<League>(() => currentLeague());
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [view, setView] = useState<View>('blend');
  const [punts, setPunts] = useState<Set<string>>(new Set());
  const [restOfSeason, setRestOfSeason] = useState(false);
  const [team, setTeam] = useState('');
  const [positions, setPositions] = useState<Set<PositionLetter>>(new Set());
  const [minGames, setMinGames] = useState(0);
  const [hideOut, setHideOut] = useState(false);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState('value');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [shown, setShown] = useState(PAGE);

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
      if (view === 'pergame') {
        value = num(r, 'points_pg');
      } else {
        const parts = active.map((c) => num(r, zKey(view, c)));
        value = parts.every((p) => p === null) ? null : parts.reduce<number>((s, p) => s + (p ?? 0), 0);
        if (value !== null && view === 'blend' && restOfSeason && !r.season_complete && r.value_total) {
          value *= (r.value_rest_of_season ?? r.value_total) / r.value_total;
        }
      }
      return { row: r, value };
    });
  }, [rows, view, punts, restOfSeason]);

  const ranked = useMemo(() => {
    const filtered = scored
      .filter(({ row }) => !team || row.team_abbreviation === team)
      .filter(({ row }) => eligibleAt(row.position, positions))
      .filter(({ row }) => (row.games_current ?? 0) >= minGames)
      .filter(({ row }) => !hideOut || row.injury_group !== 'out')
      .filter(({ row }) => !query || (row.full_name ?? '').toLowerCase().includes(query.toLowerCase()))
      .filter(({ value }) => view === 'blend' || value !== null);
    const get = (s: (typeof filtered)[number]): number | string | null => {
      if (sortKey === 'value') return s.value;
      if (sortKey === 'name') return s.row.full_name;
      if (sortKey === 'team') return s.row.team_abbreviation;
      if (sortKey === 'pos') return s.row.position;
      return num(s.row, sortKey);
    };
    return sortRows(filtered, get, sortDir);
  }, [scored, team, positions, minGames, hideOut, query, sortKey, sortDir, view]);

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
  const showNext7 = !meta.complete;
  const categoryColumns = view === 'pergame' ? PER_GAME.map((c) => ({ key: c.key as string, label: c.label })) : CATEGORIES.map((c) => ({ key: zKey(view, c), label: CATEGORY_LABELS[c] ?? c, category: c }));

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      {meta.complete ? (
        <Note testid="season-note">
          The {LEAGUE_LABEL[league]} {meta.season} regular season is over. Values blend the full season with the two before
          it; rest-of-season ranking returns when the next schedule is out.
        </Note>
      ) : (
        <Note testid="season-note">
          {LEAGUE_LABEL[league]} {meta.season}: up to {meta.maxGames} game{meta.maxGames === 1 ? '' : 's'} played and up to{' '}
          {meta.remaining} left per team.
          {meta.maxGames < 20 ? ' This season’s weight in the blend grows to its full share at 20 games.' : ''}
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

      {view !== 'pergame' && (
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Punt (drop from the total)</legend>
          {CATEGORIES.map((c) => (
            <Chip key={c} checked={punts.has(c)} onChange={() => setPunts(toggle(punts, c))}>
              {CATEGORY_LABELS[c]}
            </Chip>
          ))}
          {view === 'blend' && (
            <label className={`ml-2 flex items-center gap-2 text-sm ${meta.complete ? 'text-muted' : ''}`}>
              <input
                type="checkbox"
                checked={restOfSeason && !meta.complete}
                disabled={meta.complete}
                onChange={(e) => setRestOfSeason(e.target.checked)}
              />
              Rest of season (games left × availability)
            </label>
          )}
        </fieldset>
      )}

      <div className="flex flex-wrap items-center gap-3">
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
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={hideOut} onChange={(e) => setHideOut(e.target.checked)} />
          Hide players ruled out
        </label>
        <span className="text-sm text-muted">{ranked.length} players</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="Scrollable table">
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
              <SortTh right active={sortKey === 'games_current'} dir={sortDir} onClick={() => sortBy('games_current')} title="Games this season">
                GP
              </SortTh>
              {showNext7 && (
                <SortTh right active={sortKey === 'games_next_7'} dir={sortDir} onClick={() => sortBy('games_next_7')} title="Team games in the next 7 days">
                  Next 7
                </SortTh>
              )}
              {categoryColumns.map((c) => {
                const punted = 'category' in c && punts.has(c.category as string);
                return (
                  <SortTh key={c.key} right active={sortKey === c.key} dir={sortDir} onClick={() => sortBy(c.key, c.label === 'TO' && view === 'pergame' ? 'asc' : 'desc')}>
                    {punted ? <s>{c.label}</s> : c.label}
                  </SortTh>
                );
              })}
              {view !== 'pergame' && (
                <SortTh right active={sortKey === 'value'} dir={sortDir} onClick={() => sortBy('value')}>
                  Total
                </SortTh>
              )}
            </tr>
          </thead>
          <tbody>
            {ranked.slice(0, shown).map(({ row, value }, i) => (
              <tr key={row.player_id} className="border-t border-line">
                <Td right>{i + 1}</Td>
                <Td>
                  <a href={href(`/p/${league}/${row.player_id}/`)} className="underline-offset-4 hover:underline">
                    {row.full_name ?? row.player_id}
                  </a>
                  <InjuryTag
                    group={row.injury_group}
                    status={row.injury_status}
                    detail={[row.injury_type, row.expected_return ? `return ${day(row.expected_return)}` : null, row.injury_note]
                      .filter(Boolean)
                      .join(' · ')}
                  />
                </Td>
                <Td>{row.team_abbreviation ?? '–'}</Td>
                <Td>{row.position ?? '–'}</Td>
                <Td right>{row.games_current ?? 0}</Td>
                {showNext7 && <Td right>{row.games_next_7 ?? 0}</Td>}
                {view === 'pergame'
                  ? PER_GAME.map((c) => (
                      <Td key={c.key as string} right>
                        {c.kind === 'pct' ? pct(num(row, c.key as string)) : fmt(num(row, c.key as string))}
                      </Td>
                    ))
                  : CATEGORIES.map((c) => (
                      <Td key={c} right>
                        <Signed value={punts.has(c) ? null : num(row, zKey(view, c))} />
                      </Td>
                    ))}
                {view !== 'pergame' && (
                  <Td right>
                    <strong>{fmt(value, 2)}</strong>
                  </Td>
                )}
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
