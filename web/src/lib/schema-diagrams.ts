/**
 * The Schema page's diagrams, generated from the dbt project (src/generated/schema.json):
 * entity-relationship diagrams of the gold layer by subject area, in UML class notation, and
 * the lineage of every model by layer from the landing zone.
 */
import schema from '../generated/schema.json';
import { DOT_DEFAULTS, esc, renderDot, TOKEN as T } from './diagram';

interface Column {
  name: string;
  type: string;
  tests: string[];
}
interface Model {
  name: string;
  materialized: string;
  reads: string[];
  read_by: string[];
  columns: Column[];
}

const layers = schema.layers as { name: string; models: Model[] }[];
const gold = layers.find((l) => l.name === 'gold')?.models ?? [];
const goldByName = new Map(gold.map((m) => [m.name, m]));
const relationships = (schema as { relationships?: { from: string; column: string; to: string; field: string }[] }).relationships ?? [];
const landing = (schema as { landing?: { path: string; read_by: string[] }[] }).landing ?? [];

type Kind = 'dimension' | 'fact' | 'mart';
const kind = (name: string): Kind => (name.startsWith('dim_') ? 'dimension' : name.startsWith('fct_') ? 'fact' : 'mart');
const pkOf = (m: Model) => m.columns.find((c) => c.tests.includes('unique') && c.name.endsWith('_sk'))?.name;
const has = (m: Model, col: string) => m.columns.some((c) => c.name === col);

// Surrogate keys of the dimensions, and the columns that point at them.
const dimKeys = new Map<string, string>();
for (const m of gold) if (kind(m.name) === 'dimension') dimKeys.set(pkOf(m) ?? '', m.name);
const SK_ALIASES: Record<string, string> = { home_team_sk: 'team_sk', away_team_sk: 'team_sk', opponent_team_sk: 'team_sk' };
const NATURAL = ['date_day', 'league', 'season', 'stats_player_id', 'player_id', 'team_id', 'home_team_id', 'away_team_id', 'game_id', 'game_date', 'valid_from', 'is_current'];

/**
 * A join between two gold models. `many` is the side with many rows per row of `one`;
 * `oneToOne` marks two models with the same key. `key` is a surrogate key column (shown as
 * FK on the entity); natural-key joins carry the columns in the label instead.
 */
interface Rel {
  many: string;
  one: string;
  label: string;
  tested: boolean;
  oneToOne?: boolean;
  key?: string;
}

/** Every join in the gold layer, derived from the columns and the relationships tests. */
function goldRels(): Rel[] {
  const out: Rel[] = [];
  const seen = new Set<string>();
  for (const r of relationships) {
    if (!goldByName.has(r.from) || !goldByName.has(r.to)) continue;
    out.push({ many: r.from, one: r.to, label: r.column, tested: true, key: r.column });
    seen.add(`${r.from}|${r.column}`);
  }
  for (const m of gold) {
    const pk = pkOf(m);
    // Surrogate keys that point at a dimension.
    for (const c of m.columns) {
      const target = dimKeys.get(SK_ALIASES[c.name] ?? c.name);
      if (!target || target === m.name || c.name === pk || seen.has(`${m.name}|${c.name}`)) continue;
      out.push({ many: m.name, one: target, label: c.name, tested: false, key: c.name });
      seen.add(`${m.name}|${c.name}`);
    }
    if (kind(m.name) === 'dimension') continue;
    // dim_player keeps a row per team stint (SCD2). Without player_sk, a model joins its player
    // on league and the player id: to the stint covering the game for a per-game row, else to the
    // current stint.
    const playerCol = has(m, 'stats_player_id') ? 'stats_player_id' : has(m, 'player_id') ? 'player_id' : null;
    if (playerCol && !has(m, 'player_sk')) {
      const stint = has(m, 'game_date') && has(m, 'game_id') ? 'stint at game_date' : 'is_current';
      out.push({ many: m.name, one: 'dim_player', label: `${playerCol} · ${stint}`, tested: false });
    }
    // dim_team has a row per league, season and team.
    if (has(m, 'season') && !has(m, 'team_sk')) {
      const cols = ['team_id', 'home_team_id', 'away_team_id'].filter((c) => has(m, c));
      if (cols.length) out.push({ many: m.name, one: 'dim_team', label: cols.join(', '), tested: false });
    }
    // Two models on one key are one-to-one (mart_player_rolling and fct_player_game).
    for (const other of gold) {
      if (other.name < m.name && pk && pkOf(other) === pk) {
        out.push({ many: m.name, one: other.name, label: pk, tested: false, oneToOne: true });
      }
    }
  }
  // A game's day is in dim_date (2018 to 2027, so unplayed games too). A fact keyed to dim_game
  // reaches it through dim_game, so only the models without game_sk draw the line themselves.
  for (const m of gold) {
    if (m.name !== 'dim_date' && has(m, 'game_date') && !has(m, 'game_sk')) {
      out.push({ many: m.name, one: 'dim_date', label: 'game_date', tested: false });
    }
  }
  return out.filter((r) => goldByName.has(r.one));
}

const RELS = goldRels();

/** Natural keys on an entity, three to a line so a box stays narrow. */
function naturalRows(m: Model): string[] {
  const names = m.columns.filter((c) => NATURAL.includes(c.name)).map((c) => c.name);
  const rows: string[] = [];
  for (let i = 0; i < names.length; i += 3) rows.push(esc(names.slice(i, i + 3).join(', ')));
  return rows;
}

function entityLabel(m: Model, fks: Set<string>): string {
  const pk = pkOf(m);
  const keyRows: string[] = [];
  if (pk) keyRows.push(`<B>PK</B> ${esc(pk)}`);
  for (const c of m.columns) if (fks.has(c.name) && c.name !== pk) keyRows.push(`<B>FK</B> ${esc(c.name)}`);
  const natural = naturalRows(m);
  if (natural.length) keyRows.push(`<FONT COLOR="${T.muted}">${natural.join('<BR/>')}</FONT>`);
  const shown = (pk ? 1 : 0) + m.columns.filter((c) => fks.has(c.name) && c.name !== pk).length + m.columns.filter((c) => NATURAL.includes(c.name)).length;
  const rest = m.columns.length - shown;
  const k = kind(m.name);
  const head = k === 'dimension' ? T.goodTint : k === 'fact' ? T.accentTint : T.warnTint;
  return `<<TABLE BORDER="0" CELLBORDER="1" CELLSPACING="0" CELLPADDING="4" COLOR="${T.line}" BGCOLOR="${T.card}">
    <TR><TD BGCOLOR="${head}"><FONT POINT-SIZE="9" COLOR="${T.muted}">«${k}» ${esc(m.materialized)}</FONT><BR/><B>${esc(m.name)}</B></TD></TR>
    <TR><TD ALIGN="LEFT" BALIGN="LEFT">${keyRows.join('<BR/>') || ' '}</TD></TR>
    <TR><TD ALIGN="LEFT"><FONT COLOR="${T.muted}">+ ${rest} more column${rest === 1 ? '' : 's'}</FONT></TD></TR>
  </TABLE>>`;
}

/** A model shown only for what it feeds (the fantasy marts' inputs): its kind and name. */
function compactLabel(m: Model): string {
  const k = kind(m.name);
  const head = k === 'dimension' ? T.goodTint : k === 'fact' ? T.accentTint : T.warnTint;
  return `<<TABLE BORDER="0" CELLBORDER="1" CELLSPACING="0" CELLPADDING="4" COLOR="${T.line}" BGCOLOR="${head}">
    <TR><TD><FONT POINT-SIZE="9" COLOR="${T.muted}">«${k}»</FONT> <B>${esc(m.name)}</B></TD></TR>
  </TABLE>>`;
}

export interface ErArea {
  id: string;
  title: string;
  about: string;
  /** Columns of the drawing, left to right; every join between two of them is drawn. */
  columns: [string[], string[], string[]];
  /** Models drawn small, for what they feed: "built from" arrows into the area's marts. */
  inputs?: string[];
}

const FANTASY = ['mart_category_zscores', 'mart_player_projection', 'mart_board', 'mart_streamers'];
const fantasyInputs = [...new Set(FANTASY.flatMap((n) => goldByName.get(n)?.reads ?? []))]
  .filter((n) => goldByName.has(n) && !FANTASY.includes(n) && kind(n) !== 'dimension')
  .sort();

const AREAS: ErArea[] = [
  {
    id: 'er-games',
    title: 'Games and players',
    about: 'The box scores, play-by-play and shots against the game, team, player and calendar dimensions, and the rolling averages kept one-to-one with the player-game rows.',
    columns: [
      ['fct_player_game', 'fct_team_game', 'fct_event', 'fct_shot'],
      ['dim_game', 'dim_player', 'dim_team', 'dim_date'],
      ['mart_player_rolling'],
    ],
  },
  {
    id: 'er-availability',
    title: 'Availability, moves and news',
    about: 'Injuries, the official report, starting lineups, transactions, headlines, waiver activity and draft market, each joined to a player by league and player id.',
    columns: [
      ['fct_availability', 'fct_injury_status', 'fct_player_status', 'fct_starting_lineup'],
      ['dim_player'],
      ['fct_transaction', 'fct_player_news', 'fct_waiver_trend', 'fct_market_value'],
    ],
  },
  {
    id: 'er-schedule',
    title: 'Schedule and context',
    about: 'Rest, travel and altitude per team and game, what each team has left to play for, and the games not yet played with their lines. Unplayed games are not in dim_game, which holds played games only.',
    columns: [['fct_team_game_context', 'fct_team_stakes'], ['dim_team', 'dim_date'], ['mart_schedule_upcoming']],
  },
  {
    id: 'er-fantasy',
    title: 'Fantasy marts',
    about: 'The z-scores, the projection, the board and streamers, with the gold models each is built from on the left (dotted arrows) and the joins to the player and team dimensions on the right.',
    columns: [fantasyInputs, FANTASY, ['dim_player', 'dim_team']],
    inputs: fantasyInputs,
  },
];

/** The subject areas, with any gold model none of them names in an extra one, so none is lost. */
export function erAreas(): ErArea[] {
  const placed = new Set(AREAS.flatMap((a) => a.columns.flat()));
  const rest = gold.map((m) => m.name).filter((n) => !placed.has(n));
  if (!rest.length) return AREAS;
  const dims = rest.filter((n) => kind(n) === 'dimension');
  return [
    ...AREAS,
    {
      id: 'er-other',
      title: 'Other gold models',
      about: 'Gold models not yet placed in a subject area.',
      columns: [rest.filter((n) => kind(n) === 'fact'), dims.length ? dims : ['dim_player'], rest.filter((n) => kind(n) === 'mart')],
    },
  ];
}

/** One subject area as an entity-relationship diagram, in UML class notation with crow's feet. */
export function erDiagram(area: ErArea): Promise<string> {
  const col = new Map<string, number>();
  area.columns.forEach((names, i) => names.forEach((n) => col.set(n, i)));
  const inputs = new Set(area.inputs ?? []);
  const rels = RELS.filter((r) => col.has(r.many) && col.has(r.one) && !inputs.has(r.many) && !inputs.has(r.one));

  // Parallel joins between the same two models share one line.
  const merged = new Map<string, Rel>();
  for (const r of rels) {
    const id = `${r.many}|${r.one}|${r.tested}|${r.oneToOne ?? false}`;
    const seen = merged.get(id);
    if (seen) seen.label = `${seen.label}, ${r.label}`;
    else merged.set(id, { ...r });
  }
  const fks = new Map<string, Set<string>>();
  for (const r of rels) if (r.key) (fks.get(r.many) ?? fks.set(r.many, new Set()).get(r.many))?.add(r.key);

  const names = area.columns.flat();
  const nodes = names
    .map((n) => {
      const m = goldByName.get(n);
      if (!m) return '';
      const label = inputs.has(n) ? compactLabel(m) : entityLabel(m, fks.get(n) ?? new Set());
      return `"${n}" [shape=plain, URL="#m-${n}", tooltip="${n}", label=${label}];`;
    })
    .join('\n');

  // Draw every line left to right so the columns hold; the arrow ends say which side is many.
  const lines = [...merged.values()].map((r) => {
    const style = `label="${esc(r.label)}"${r.tested ? '' : ', style=dashed'}`;
    const manyEnd = r.oneToOne ? 'tee' : 'crow';
    const sameColumn = col.get(r.many) === col.get(r.one) ? ', constraint=false' : '';
    return (col.get(r.many) ?? 0) <= (col.get(r.one) ?? 0)
      ? `"${r.many}" -> "${r.one}" [dir=both, arrowtail=${manyEnd}, arrowhead=tee, ${style}${sameColumn}];`
      : `"${r.one}" -> "${r.many}" [dir=both, arrowtail=tee, arrowhead=${manyEnd}, ${style}${sameColumn}];`;
  });
  // Built from: an input (or another mart of the area) feeds a mart.
  if (inputs.size) {
    const joined = new Set(rels.map((r) => `${r.many}|${r.one}`));
    for (const target of area.columns[1]) {
      for (const source of goldByName.get(target)?.reads ?? []) {
        if (!col.has(source) || joined.has(`${target}|${source}`)) continue;
        const flat = col.get(source) === col.get(target) ? ', constraint=false' : '';
        lines.push(`"${source}" -> "${target}" [style=dotted, arrowhead=vee, penwidth=1.3, color="${T.muted}"${flat}];`);
      }
    }
  }
  const ranks = area.columns
    .filter((c) => c.length)
    .map((c) => `{ rank=same; ${c.map((n) => `"${n}"`).join('; ')}; }`)
    .join('\n');
  return renderDot(`digraph ${area.id.replace(/-/g, '_')} {
    ${DOT_DEFAULTS}
    rankdir=LR; nodesep=0.25; ranksep=0.35; newrank=true;
    ${ranks}
    ${nodes}
    ${lines.join('\n')}
  }`);
}

/** Lineage of every model, by layer, from the landing folders and the seeds. */
export function lineage(): Promise<string> {
  const seeds = (schema.seeds as { name: string }[]).map((s) => s.name);
  const fill: Record<string, string> = { bronze: T.warnTint, silver: T.bg, gold: T.goodTint, ops: T.accentTint };
  const clusters = layers
    .map(
      (l) => `subgraph cluster_${l.name} {
        label="${l.name} · ${l.models.length}"; labeljust=l; style="rounded,filled"; fillcolor="${fill[l.name] ?? T.bg}"; color="${T.line}";
        ${l.models.map((m) => `"${m.name}" [URL="#m-${m.name}"];`).join(' ')}
      }`,
    )
    .join('\n');
  const landed = landing
    .map((f) => `"landing/${f.path}" [label="${esc(f.path)}", shape=folder, fillcolor="${T.bg}"];`)
    .join(' ');
  const landingEdges = landing.flatMap((f) => f.read_by.map((m) => `"landing/${f.path}" -> "${m}";`)).join('\n');
  const edges = layers.flatMap((l) => l.models.flatMap((m) => m.reads.map((r) => `"${r}" -> "${m.name}";`))).join('\n');
  return renderDot(`digraph lineage {
    ${DOT_DEFAULTS}
    rankdir=LR; nodesep=0.1; ranksep=0.55; concentrate=true; splines=true;
    node [shape=box, style="rounded,filled", fillcolor="${T.card}", fontsize=10, height=0.28, margin="0.08,0.03"];
    edge [arrowsize=0.5, color="${T.line}"];
    subgraph cluster_landing { label="landing · ${landing.length}"; labeljust=l; style="rounded,dashed"; color="${T.line}";
      ${landed} }
    subgraph cluster_seeds { label="seeds · ${seeds.length}"; labeljust=l; style="rounded,dashed"; color="${T.line}";
      ${seeds.map((s) => `"${s}" [URL="#seed-${s}", shape=note];`).join(' ')} }
    ${clusters}
    ${landingEdges}
    ${edges}
  }`);
}

/** How to read an area's diagram. */
export function erCaption(area: ErArea): string {
  return area.inputs?.length
    ? `The small boxes on the left are the gold models the marts are built from: a dotted arrow points from a model to a mart built from it, as in the lineage below. ${erLegend}`
    : erLegend;
}

const erLegend =
  'Solid lines are foreign keys a dbt relationships test enforces; dashed lines are joins no test enforces, on a surrogate key or on natural keys: a team on league, season and team id (dim_team has a row per season), a day on game_date (a fact keyed to dim_game reaches it through dim_game), a player on league and player id to the current stint (is_current) or, for a row of one game, to the stint that covers its date (dim_player keeps a row per team stint). Crow’s feet mark the many side; two bars at both ends mark one-to-one. Only the joins between models in the same drawing are shown.';
