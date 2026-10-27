import { useEffect, useMemo, useState } from 'react';

import { fetchBuildJson, type League } from '../lib/data';
import { CATEGORIES, CATEGORY_LABELS, fmt } from '../lib/format';
import { currentLeague } from '../lib/league';
import { href } from '../lib/site';
import { Loading, Problem, Signed, Td, Th } from './ui';

interface BoardRow {
  player_id: string;
  season: string;
  full_name: string | null;
  position: string | null;
  team_id: string | null;
  team_abbreviation: string | null;
  games_current: number | null;
  in_pool: boolean | null;
  availability_multiplier: number | null;
  value_total: number | null;
  value_rest_of_season: number | null;
  rank_total: number;
  [key: string]: unknown;
}

function z(row: BoardRow, key: string): number {
  const v = row[key];
  return typeof v === 'number' && !Number.isNaN(v) ? v : 0;
}

export default function Board() {
  const [league] = useState<League>(() => currentLeague());
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [punts, setPunts] = useState<Set<string>>(new Set());
  const [availability, setAvailability] = useState(false);
  const [team, setTeam] = useState('');
  const [position, setPosition] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let live = true;
    fetchBuildJson<BoardRow[]>(`board/${league}.json`)
      .then((data) => live && setRows(data))
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, [league]);

  const teams = useMemo(() => [...new Set((rows ?? []).map((r) => r.team_abbreviation).filter(Boolean))].sort(), [rows]);
  const positions = useMemo(() => [...new Set((rows ?? []).map((r) => r.position).filter(Boolean))].sort(), [rows]);

  const ranked = useMemo(() => {
    if (!rows) return [];
    const active = CATEGORIES.filter((c) => !punts.has(c));
    const scored = rows.map((r) => {
      const base = active.reduce((sum, c) => sum + z(r, c), 0);
      const seasonShare =
        availability && r.value_total && r.value_rest_of_season !== null
          ? r.value_rest_of_season / r.value_total
          : 1;
      const mult = availability ? (r.availability_multiplier ?? 1) : 1;
      return { row: r, value: base * seasonShare * mult };
    });
    return scored
      .filter(({ row }) => !team || row.team_abbreviation === team)
      .filter(({ row }) => !position || row.position === position)
      .filter(({ row }) => !query || (row.full_name ?? '').toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => b.value - a.value);
  }, [rows, punts, availability, team, position, query]);

  if (error) return <Problem error={error} />;
  if (!rows) return <Loading what="the board" />;

  const togglePunt = (c: string) => {
    const next = new Set(punts);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    setPunts(next);
  };

  return (
    <div>
      <div className="flex flex-wrap items-end gap-4">
        <fieldset className="flex flex-wrap gap-2">
          <legend className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Punt</legend>
          {CATEGORIES.map((c) => (
            <label key={c} className="flex cursor-pointer items-center gap-1 rounded-full border border-line px-2 py-1 text-sm has-checked:bg-accent has-checked:text-accent-fg">
              <input type="checkbox" className="sr-only" checked={punts.has(c)} onChange={() => togglePunt(c)} />
              {CATEGORY_LABELS[c]}
            </label>
          ))}
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={availability} onChange={(e) => setAvailability(e.target.checked)} />
          Rest-of-season and availability adjustment
        </label>
      </div>
      <div className="mt-3 flex flex-wrap gap-3">
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
            {teams.map((t) => (
              <option key={t as string} value={t as string}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="sr-only">Position</span>
          <select value={position} onChange={(e) => setPosition(e.target.value)} className="rounded border border-line bg-card px-2 py-1">
            <option value="">All positions</option>
            {positions.map((p) => (
              <option key={p as string} value={p as string}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <p className="self-center text-sm text-muted">
          {ranked.length} players · season {rows[0]?.season ?? ''}
        </p>
      </div>
      <div className="mt-4 overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm" data-testid="board">
          <thead className="bg-card">
            <tr>
              <Th right>#</Th>
              <Th>Player</Th>
              <Th>Team</Th>
              <Th>Pos</Th>
              <Th right>GP</Th>
              {CATEGORIES.map((c) => (
                <Th key={c} right>
                  {punts.has(c) ? <s>{CATEGORY_LABELS[c]}</s> : CATEGORY_LABELS[c]}
                </Th>
              ))}
              <Th right>Total</Th>
            </tr>
          </thead>
          <tbody>
            {ranked.slice(0, 300).map(({ row, value }, i) => (
              <tr key={row.player_id} className="border-t border-line">
                <Td right>{i + 1}</Td>
                <Td>
                  <a href={href(`/p/${league}/${row.player_id}/`)} className="underline-offset-4 hover:underline">
                    {row.full_name ?? row.player_id}
                  </a>
                </Td>
                <Td>{row.team_abbreviation ?? '–'}</Td>
                <Td>{row.position ?? '–'}</Td>
                <Td right>{row.games_current ?? 0}</Td>
                {CATEGORIES.map((c) => (
                  <Td key={c} right>
                    <Signed value={punts.has(c) ? null : z(row, c)} />
                  </Td>
                ))}
                <Td right>
                  <strong>{fmt(value, 2)}</strong>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
