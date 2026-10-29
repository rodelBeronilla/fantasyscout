import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { downloadCsv, toCsv } from '../lib/csv';
import { fetchBuildJson, type League } from '../lib/data';
import { CATEGORIES, CATEGORY_LABELS, day, fmt, pct } from '../lib/format';
import { currentLeague, LEAGUE_LABEL } from '../lib/league';
import { eligibleAt, POSITION_LETTERS, type PositionLetter, sortRows, type SortDir, toggle } from '../lib/players';
import { href } from '../lib/site';
import { useWatchlist } from '../lib/watchlist';
import { draftPick, owners, undoPick, useLeague } from '../lib/fantasy-league';
import { categoryValues, fitWeights, leagueTiers, pointValues, primaryPosition, type Tier } from '../lib/league-value';
import { DraftBar, LeagueBar } from './LeagueParts';
import { Chip, InjuryTag, LineupTag, Loading, NewTeam, Note, Problem, Signed, SortTh, Star, Td, Th } from './ui';

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
  injury_news?: string | null;
  injury_since?: string | null;
  /** official when the league's injury report sets the status for the next game, else espn. */
  injury_source?: string | null;
  official_game_date?: string | null;
  official_report_at?: string | null;
  lineup_role?: string | null;
  lineup_confirmed?: boolean | null;
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
    help: 'Value per game above replacement in your league, from each player’s projected line, times the share of games they are projected to play. Zero is a player you could pick up for free.',
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
type Show = 'available' | 'mine' | 'all';

const PAGE = 100;
const COMPARE_MAX = 4;

function num(row: BoardRow, key: string): number | null {
  const v = row[key];
  return typeof v === 'number' && !Number.isNaN(v) ? v : null;
}

const select = 'rounded border border-line bg-card px-2 py-1';

/** A row of mutually exclusive buttons. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; title?: string }[];
  onChange: (id: T) => void;
}) {
  return (
    <div className="inline-flex flex-wrap rounded-lg border border-line bg-card p-0.5" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          title={o.title}
          onClick={() => onChange(o.id)}
          className={`rounded-md px-3 py-1 text-sm ${value === o.id ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function roundsLabel(t: Tier): string {
  return t.firstRound === t.lastRound ? `round ${t.firstRound}` : `rounds ${t.firstRound}–${t.lastRound}`;
}

/** The row that opens a tier: where its picks fall in a draft, its value range, and how many are left. */
function TierHead({ tier, columns, left, size }: { tier: Tier | null; columns: number; left: number | null; size: number }) {
  return (
    <tr className="border-t-2 border-accent bg-bg" data-testid="tier-head">
      <td colSpan={columns} className="px-2 pt-2 pb-1 text-xs">
        <span className="sticky left-2 inline-block">
          {tier ? (
            <>
              <strong className="text-accent">Tier {tier.tier}</strong>{' '}
              <span className="text-muted">
                · {tier.start === tier.end ? `pick ${tier.start + 1}` : `picks ${tier.start + 1}–${tier.end + 1}`} ({roundsLabel(tier)}) · value {tier.start === tier.end ? fmt(tier.high, 1) : `${fmt(tier.high, 1)} to ${fmt(tier.low, 1)}`}
                {left !== null ? ` · ${left} of ${size} available` : ''}
              </span>
            </>
          ) : (
            <>
              <strong>Beyond the rostered pool</strong>{' '}
              <span className="text-muted">· players a league this size leaves on waivers</span>
            </>
          )}
        </span>
      </td>
    </tr>
  );
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
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [showChoice, setShowChoice] = useState<Show | null>(null);
  const { watched, toggleWatched } = useWatchlist(league);
  const [setup, updateLeague] = useLeague(league);
  const owner = useMemo(() => owners(setup), [setup]);
  const hasRosters = owner.size > 0;
  // With rosters in, the board starts on the players still available.
  const show: Show = showChoice ?? (hasRosters ? 'available' : 'all');
  const points = setup.scoring === 'points';
  const pool = setup.teams * setup.rosterSpots;
  // 8-cat leagues drop turnovers; on top of that, the manager's own punts.
  const punted = useMemo(() => (setup.scoring === 'cats8' ? new Set([...punts, 'z_turnovers']) : punts), [punts, setup.scoring]);
  const activeCats = useMemo(() => CATEGORIES.filter((c) => !punted.has(c)), [punted]);
  const views = points ? VIEWS.filter((v) => v.id === 'value' || v.id === 'projected') : VIEWS;
  useEffect(() => {
    if (points && view !== 'value' && view !== 'projected') setView('value');
  }, [points, view]);

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

  // Category values above this league's replacement level, and points if the league scores points.
  const leagueCats = useMemo(
    () => (rows && !points ? categoryValues(rows, activeCats, pool, setup.teams) : null),
    [rows, points, activeCats, pool, setup.teams],
  );
  const leaguePoints = useMemo(
    () => (rows && points ? pointValues(rows, setup.weights, pool, setup.teams) : null),
    [rows, points, setup.weights, pool, setup.teams],
  );

  // The manager's team: its category totals set how much each category counts in Fit.
  const myTeam = useMemo(() => (rows ?? []).filter((r) => owner.get(r.player_id) === setup.mine), [rows, owner, setup.mine]);
  const teamTotals = useMemo(() => {
    if (!leagueCats || myTeam.length === 0) return null;
    return Object.fromEntries(activeCats.map((c) => [c, myTeam.reduce((s, r) => s + (leagueCats.get(r.player_id)?.[c] ?? 0), 0)]));
  }, [leagueCats, myTeam, activeCats]);
  const weights = useMemo(() => (teamTotals ? fitWeights(teamTotals) : null), [teamTotals]);
  const weakest = useMemo(
    () => (teamTotals ? Object.entries(teamTotals).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([c]) => c) : []),
    [teamTotals],
  );

  const scored = useMemo(() => {
    if (!rows) return [];
    const scale = (r: BoardRow, v: number) => {
      // Only value above replacement scales: a game missed by a player not worth rostering costs nothing.
      let out = v;
      if (out > 0 && countGames) out *= r.games_share ?? 1;
      if (out > 0 && restOfSeason && !r.season_complete) out *= r.ros_factor ?? 1;
      return out;
    };
    return rows.map((r) => {
      let value: number | null;
      let fit: number | null = null;
      if (isLine(view)) {
        value = num(r, view === 'projected' ? 'proj_points_pg' : 'points_pg');
      } else if (view === 'value' && leaguePoints) {
        value = scale(r, leaguePoints.get(r.player_id)?.value ?? 0);
      } else if (view === 'value' && leagueCats) {
        const cats = leagueCats.get(r.player_id) ?? {};
        value = scale(r, activeCats.reduce((s, c) => s + (cats[c] ?? 0), 0));
        if (weights) fit = scale(r, activeCats.reduce((s, c) => s + (weights[c] ?? 1) * (cats[c] ?? 0), 0));
      } else {
        const parts = activeCats.map((c) => num(r, zKey(view, c)));
        value = parts.every((p) => p === null) ? null : parts.reduce<number>((s, p) => s + (p ?? 0), 0);
      }
      return { row: r, value, fit };
    });
  }, [rows, view, activeCats, restOfSeason, countGames, leagueCats, leaguePoints, weights]);

  // Position ranks and tiers, over every player in the current value order.
  const { posRank, tiers } = useMemo(() => {
    const order = [...scored].filter((s) => s.value !== null).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const counts = new Map<string, number>();
    const rank = new Map<string, string>();
    for (const s of order) {
      const p = primaryPosition(s.row.position);
      if (!p) continue;
      counts.set(p, (counts.get(p) ?? 0) + 1);
      rank.set(s.row.player_id, `${p}${counts.get(p)}`);
    }
    if (view !== 'value') return { posRank: rank, tiers: null };
    const list = leagueTiers(order.map((s) => s.value ?? 0), setup.teams, setup.rosterSpots);
    const of = new Map<string, number>();
    const left = new Map<number, number>();
    for (const t of list) {
      const members = order.slice(t.start, t.end + 1);
      for (const s of members) of.set(s.row.player_id, t.tier);
      left.set(t.tier, members.filter((s) => !owner.has(s.row.player_id)).length);
    }
    return { posRank: rank, tiers: { list, of, left } };
  }, [scored, view, setup.teams, setup.rosterSpots, owner]);

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
      .filter(({ row }) => show === 'all' || (show === 'mine' ? owner.get(row.player_id) === setup.mine : !owner.has(row.player_id)))
      .filter(({ row }) => !q || (row.full_name ?? '').toLowerCase().includes(q))
      .filter(({ value }) => view === 'value' || value !== null);
    const get = (s: (typeof filtered)[number]): number | string | null => {
      if (sortKey === 'value') return s.value;
      if (sortKey === 'fit') return s.fit;
      if (sortKey === 'fpts') return leaguePoints?.get(s.row.player_id)?.fpts ?? null;
      if (sortKey === 'name') return s.row.full_name;
      if (sortKey === 'team') return s.row.team_abbreviation;
      if (sortKey === 'pos') return s.row.position;
      return num(s.row, sortKey);
    };
    return sortRows(filtered, get, sortDir);
  }, [scored, team, positions, minGames, minMinutes, availability, rookiesOnly, movedOnly, watchOnly, watched, show, owner, setup.mine, query, sortKey, sortDir, view, leaguePoints]);

  if (error) return <Problem error={error} />;
  if (!rows) return <Loading what="the board" />;

  const sortBy = (key: string, defaultDir: SortDir = 'desc') => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      setSortDir(defaultDir);
    }
  };
  const pickView = (v: View) => {
    setView(v);
    setSortKey('value');
    setSortDir('desc');
  };
  const toggleCompare = (id: string) =>
    setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= COMPARE_MAX ? c : [...c, id]));
  const showNext7 = !meta.complete;
  type Column = { key: string; label: string; kind: 'num' | 'pct' | 'z' | 'fpts'; category?: string };
  const categoryColumns: Column[] = isLine(view)
    ? lineColumns(view).map((c) => ({ key: c.key, label: c.label, kind: c.kind }))
    : view === 'value' && points
      ? [{ key: 'fpts', label: 'FPts/G', kind: 'fpts' }, ...lineColumns('projected').map((c) => ({ key: c.key, label: c.label, kind: c.kind }))]
      : CATEGORIES.map((c) => ({ key: zKey(view, c), label: CATEGORY_LABELS[c] ?? c, category: c, kind: 'z' as const }));
  /** A category cell: in the value view, measured against this league's replacement level. */
  const catValue = (row: BoardRow, c: string): number | null => {
    if (punted.has(c)) return null;
    if (view === 'value' && leagueCats) return leagueCats.get(row.player_id)?.[c] ?? null;
    return num(row, zKey(view, c));
  };
  const showFit = view === 'value' && !points && myTeam.length > 0;
  const showTiers = tiers !== null && sortKey === 'value' && sortDir === 'desc';
  const fitOf = new Map(scored.map((s) => [s.row.player_id, s.fit]));
  const byId = new Map(rows.map((r) => [r.player_id, r]));
  const compared = compare.map((id) => byId.get(id)).filter((r): r is BoardRow => !!r);
  const valueOf = new Map(scored.map((s) => [s.row.player_id, s.value]));
  const columns = 6 + (view === 'value' ? 1 : 0) + (showNext7 ? 1 : 0) + categoryColumns.length + (showFit ? 1 : 0) + (isLine(view) ? 0 : 1) + 1;
  const lastPick = setup.picks.at(-1);
  const ownerName = (id: string) => {
    const t = owner.get(id);
    return t === undefined ? null : t === setup.mine ? 'Mine' : (setup.names[t] ?? null);
  };

  // Filters and options behind the Filters button, each shown as a chip while it applies.
  const active: { label: string; clear: () => void }[] = [
    ...(!isLine(view) && !points ? [...punts].map((c) => ({ label: `Punt ${CATEGORY_LABELS[c] ?? c}`, clear: () => setPunts(toggle(punts, c)) })) : []),
    ...(view === 'value' && !countGames ? [{ label: 'Games played not counted', clear: () => setCountGames(true) }] : []),
    ...(view === 'value' && restOfSeason && !meta.complete ? [{ label: 'Rest of season', clear: () => setRestOfSeason(false) }] : []),
    ...(team ? [{ label: `Team ${team}`, clear: () => setTeam('') }] : []),
    ...(minGames ? [{ label: `${minGames}+ games`, clear: () => setMinGames(0) }] : []),
    ...(minMinutes ? [{ label: `${minMinutes}+ MPG`, clear: () => setMinMinutes(0) }] : []),
    ...(availability !== 'all' ? [{ label: availability === 'healthy' ? 'Healthy only' : 'No players ruled out', clear: () => setAvailability('all') }] : []),
    ...(rookiesOnly ? [{ label: 'Rookies', clear: () => setRookiesOnly(false) }] : []),
    ...(movedOnly ? [{ label: 'Changed teams', clear: () => setMovedOnly(false) }] : []),
    ...(watchOnly ? [{ label: 'Watchlist', clear: () => setWatchOnly(false) }] : []),
  ];

  const exportCsv = () => {
    const header = ['rank', 'player', 'team', 'position', 'age', 'rookie', 'new_team_from', 'games', 'games_share', ...categoryColumns.map((c) => c.label)];
    if (!isLine(view)) header.push('total');
    header.push('tier', 'fantasy_team');
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
        ...categoryColumns.map((c) =>
          c.kind === 'fpts' ? (leaguePoints?.get(row.player_id)?.fpts ?? null) : c.category ? catValue(row, c.category) : num(row, c.key),
        ),
      ];
      if (!isLine(view)) cells.push(value);
      const t = owner.get(row.player_id);
      cells.push(tiers?.of.get(row.player_id) ?? null, t === undefined ? null : (setup.names[t] ?? null));
      return cells;
    });
    downloadCsv(`fantasyscout-${league}-board-${view}.csv`, toCsv(header, body));
  };

  const body: ReactNode[] = [];
  let currentTier: number | undefined;
  ranked.slice(0, shown).forEach(({ row, value }, i) => {
    if (showTiers) {
      const t = tiers.of.get(row.player_id) ?? 0;
      if (t !== currentTier) {
        const tier = tiers.list[t - 1] ?? null;
        body.push(
          <TierHead
            key={`tier-${t}`}
            tier={tier}
            columns={columns}
            left={hasRosters && tier ? (tiers.left.get(t) ?? 0) : null}
            size={tier ? tier.end - tier.start + 1 : 0}
          />,
        );
        currentTier = t;
      }
    }
    const held = ownerName(row.player_id);
    body.push(
      <tr key={row.player_id} className={`border-t border-line ${held === 'Mine' ? 'bg-good/10' : held ? 'text-muted' : ''}`} data-player={row.player_id}>
        <Td right>{i + 1}</Td>
        <Td>
          <span className="flex items-center gap-1 whitespace-nowrap">
            {setup.drafting && !held && (
              <button
                type="button"
                onClick={() => updateLeague((s) => draftPick(s, row.player_id))}
                className="rounded border border-accent px-1.5 text-xs text-accent hover:bg-accent hover:text-accent-fg"
                aria-label={`Draft ${row.full_name ?? row.player_id}`}
                data-testid="draft"
              >
                Draft
              </button>
            )}
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
            <LineupTag role={row.lineup_role} confirmed={row.lineup_confirmed} />
            <InjuryTag
              group={row.injury_group}
              status={row.injury_status}
              detail={[
                row.injury_source === 'official' && row.official_game_date
                  ? `Official report for ${day(row.official_game_date)}${row.official_report_at ? ` (${row.official_report_at.slice(11, 16)} ET)` : ''}`
                  : null,
                row.injury_type,
                row.injury_since ? `since ${day(row.injury_since)}` : null,
                row.expected_return ? `return ${day(row.expected_return)}` : null,
                row.injury_news || row.injury_note,
              ]
                .filter(Boolean)
                .join(' · ')}
            />
            {held && (
              <span
                className={`max-w-[9rem] truncate rounded border px-1 text-[10px] ${held === 'Mine' ? 'border-good text-good' : 'border-line'}`}
                title={held === 'Mine' ? 'On your team' : `On ${held}`}
                data-testid="owner"
              >
                {held}
              </span>
            )}
          </span>
        </Td>
        <Td>{row.team_abbreviation ?? '–'}</Td>
        <Td>
          {row.position ?? '–'}
          {posRank.get(row.player_id) && (
            <span className="ml-1 text-[10px] text-muted" title="Rank among players at this position" data-testid="pos-rank">
              {posRank.get(row.player_id)}
            </span>
          )}
        </Td>
        <Td right>{row.age ?? '–'}</Td>
        <Td right>{row.games_current ?? 0}</Td>
        {view === 'value' && <Td right>{pct(row.games_share)}</Td>}
        {showNext7 && <Td right>{row.games_next_7 ?? 0}</Td>}
        {categoryColumns.map((c) => (
          <Td key={c.key} right>
            {c.kind === 'fpts' ? (
              fmt(leaguePoints?.get(row.player_id)?.fpts ?? null, 1)
            ) : c.kind === 'z' ? (
              <Signed value={c.category ? catValue(row, c.category) : null} />
            ) : c.kind === 'pct' ? (
              pct(num(row, c.key))
            ) : (
              fmt(num(row, c.key))
            )}
          </Td>
        ))}
        {showFit && (
          <Td right>
            <Signed value={fitOf.get(row.player_id) ?? null} />
          </Td>
        )}
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
      </tr>,
    );
  });

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      {meta.complete ? (
        <Note testid="season-note">
          The {LEAGUE_LABEL[league]} {meta.season} regular season is over. Values project next season from this one and the two before it, for
          players on a current roster; rest-of-season ranking returns when the next schedule is out.
        </Note>
      ) : (
        <Note testid="season-note">
          {LEAGUE_LABEL[league]} {meta.season}: up to {meta.maxGames} game{meta.maxGames === 1 ? '' : 's'} played and up to {meta.remaining} left
          per team.
          {meta.maxGames < 20 ? ' Projections count this season by games played, so a few games move a value only a little.' : ''}
          {meta.injured ? ` ${meta.injured} players are on the current injury report.` : ''}
        </Note>
      )}

      <LeagueBar setup={setup} rostered={owner.size} myCount={myTeam.length} weakest={view === 'value' ? weakest : []} />
      {setup.drafting && (
        <DraftBar
          setup={setup}
          lastName={lastPick ? (byId.get(lastPick.player)?.full_name ?? null) : null}
          onUndo={() => updateLeague(undoPick)}
          onEnd={() => updateLeague((s) => ({ ...s, drafting: false }))}
        />
      )}

      <div className="grid gap-1">
        <Segmented label="Value view" value={view} options={views.map((v) => ({ id: v.id, label: v.label, title: v.help }))} onChange={pickView} />
        <p className="text-xs text-muted">{VIEWS.find((v) => v.id === view)?.help}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2" data-testid="board-filters">
        <label className="text-sm">
          <span className="sr-only">Search player</span>
          <input type="search" placeholder="Search player" value={query} onChange={(e) => setQuery(e.target.value)} className={`${select} w-40`} />
        </label>
        <div className="flex items-center gap-1" role="group" aria-label="Position">
          {POSITION_LETTERS.map((p) => (
            <Chip key={p} label={`Position ${p}`} checked={positions.has(p)} onChange={() => setPositions(toggle(positions, p))}>
              {p}
            </Chip>
          ))}
        </div>
        {hasRosters && (
          <Segmented
            label="Show"
            value={show}
            options={[
              { id: 'available', label: 'Available' },
              { id: 'mine', label: 'My team' },
              { id: 'all', label: 'Everyone' },
            ]}
            onChange={setShowChoice}
          />
        )}
        <button
          type="button"
          aria-expanded={optionsOpen}
          aria-controls="board-options"
          onClick={() => setOptionsOpen(!optionsOpen)}
          className={`rounded border px-3 py-1 text-sm ${optionsOpen ? 'border-accent' : 'border-line'} hover:bg-card`}
          data-testid="board-options-toggle"
        >
          Filters{active.length ? ` (${active.length})` : ''} {optionsOpen ? '▴' : '▾'}
        </button>
        <span className="ml-auto text-sm text-muted">{ranked.length} players</span>
        <button type="button" onClick={exportCsv} className="rounded border border-line px-3 py-1 text-sm hover:bg-card" data-testid="board-csv">
          Export CSV
        </button>
      </div>

      {optionsOpen && (
        <div id="board-options" className="grid gap-4 rounded-lg border border-line bg-card p-3 text-sm md:grid-cols-2" data-testid="board-options">
          <fieldset className="grid content-start gap-2">
            <legend className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Players</legend>
            <div className="flex flex-wrap items-center gap-3">
              <label>
                <span className="sr-only">NBA or WNBA team</span>
                <select value={team} onChange={(e) => setTeam(e.target.value)} className={select} aria-label="Team">
                  <option value="">All teams</option>
                  {meta.teams.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="sr-only">Health</span>
                <select value={availability} onChange={(e) => setAvailability(e.target.value as Availability)} className={select} aria-label="Health">
                  <option value="all">Any health</option>
                  <option value="no_out">Hide players ruled out</option>
                  <option value="healthy">Healthy only</option>
                </select>
              </label>
              <label>
                Min games{' '}
                <select value={minGames} onChange={(e) => setMinGames(Number(e.target.value))} className={select}>
                  {[0, 5, 10, 20].map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </label>
              <label title="Projected minutes per game">
                Min MPG{' '}
                <select value={minMinutes} onChange={(e) => setMinMinutes(Number(e.target.value))} className={select}>
                  {[0, 15, 20, 25, 30].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={rookiesOnly} onChange={(e) => setRookiesOnly(e.target.checked)} />
                Rookies only
              </label>
              <label className="flex items-center gap-2" title="Players whose current team differs from last season's">
                <input type="checkbox" checked={movedOnly} onChange={(e) => setMovedOnly(e.target.checked)} />
                Changed teams
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={watchOnly} onChange={(e) => setWatchOnly(e.target.checked)} />
                Watchlist only ({watched.size})
              </label>
            </div>
          </fieldset>
          {!isLine(view) && (
            <fieldset className="grid content-start gap-2">
              <legend className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">{points ? 'Value' : 'Punt (drop from the total)'}</legend>
              {!points && (
                <div className="flex flex-wrap gap-1">
                  {CATEGORIES.map((c) => (
                    <Chip key={c} checked={punted.has(c)} strike onChange={() => setPunts(toggle(punts, c))}>
                      {CATEGORY_LABELS[c]}
                    </Chip>
                  ))}
                </div>
              )}
              {view === 'value' && (
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2" title="Multiply value per game by the projected share of team games played">
                    <input type="checkbox" checked={countGames} onChange={(e) => setCountGames(e.target.checked)} />
                    Count games played
                  </label>
                  <label className={`flex items-center gap-2 ${meta.complete ? 'text-muted' : ''}`} title="Value above replacement × games left × availability">
                    <input type="checkbox" checked={restOfSeason && !meta.complete} disabled={meta.complete} onChange={(e) => setRestOfSeason(e.target.checked)} />
                    Rest of season
                  </label>
                </div>
              )}
            </fieldset>
          )}
        </div>
      )}

      {active.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" data-testid="active-filters">
          {active.map((f) => (
            <button
              key={f.label}
              type="button"
              onClick={f.clear}
              className="rounded-full border border-accent px-2.5 py-0.5 text-xs text-accent hover:bg-accent hover:text-accent-fg"
              aria-label={`Remove ${f.label}`}
            >
              {f.label} ×
            </button>
          ))}
          {active.length > 1 && (
            <button type="button" onClick={() => active.forEach((f) => f.clear())} className="px-2 text-xs text-muted underline-offset-4 hover:underline">
              Clear all
            </button>
          )}
        </div>
      )}

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
                {[
                  ...CATEGORIES.map((c) => ({
                    label: CATEGORY_LABELS[c] ?? c,
                    get: (r: BoardRow) => (punted.has(c) ? null : (leagueCats?.get(r.player_id)?.[c] ?? num(r, zKey(isLine(view) ? 'value' : view, c)))),
                    kind: 'z',
                  })),
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
                const isPunted = !!c.category && punted.has(c.category);
                return (
                  <SortTh key={c.key} right active={sortKey === c.key} dir={sortDir} onClick={() => sortBy(c.key, c.label === 'TO' && c.kind !== 'z' ? 'asc' : 'desc')}>
                    {isPunted ? <s>{c.label}</s> : c.label}
                  </SortTh>
                );
              })}
              {showFit && (
                <SortTh
                  right
                  active={sortKey === 'fit'}
                  dir={sortDir}
                  onClick={() => sortBy('fit')}
                  title="Value with each category weighted by where your team is weak (1.5 for the weakest third, 1 the middle, 0.5 the strongest)"
                >
                  Fit
                </SortTh>
              )}
              {!isLine(view) && (
                <SortTh right active={sortKey === 'value'} dir={sortDir} onClick={() => sortBy('value')}>
                  Total
                </SortTh>
              )}
              <Th>Cmp</Th>
            </tr>
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
      {showTiers && (
        <p className="text-xs text-muted" data-testid="tier-note">
          Tiers split the {pool} players a league of {setup.teams} teams × {setup.rosterSpots} rosters into {tiers.list.length} groups where their
          values naturally separate (Jenks natural breaks), about one per round. Players in a tier are close in value, so when a tier is nearly gone,
          take its last player before the drop to the next.
        </p>
      )}
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
