/**
 * The Schema page's diagrams, generated from the dbt project (src/generated/schema.json):
 * an entity-relationship diagram of the gold layer in UML class notation, and the lineage of
 * every model by layer.
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
const relationships = (schema as { relationships?: { from: string; column: string; to: string; field: string }[] }).relationships ?? [];

const kind = (name: string) => (name.startsWith('dim_') ? 'dimension' : name.startsWith('fct_') ? 'fact' : 'mart');
const pkOf = (m: Model) => m.columns.find((c) => c.tests.includes('unique') && c.name.endsWith('_sk'))?.name;

// Surrogate keys of the dimensions, and the columns that point at them.
const dimKeys = new Map<string, string>();
for (const m of gold) if (kind(m.name) === 'dimension') dimKeys.set(pkOf(m) ?? '', m.name);
const SK_ALIASES: Record<string, string> = { home_team_sk: 'team_sk', away_team_sk: 'team_sk', opponent_team_sk: 'team_sk' };
const NATURAL = ['league', 'season', 'player_id', 'stats_player_id', 'team_id', 'game_id'];

interface Edge {
  from: string;
  to: string;
  label: string;
  tested: boolean;
}

function mergeParallel(list: Edge[]): Edge[] {
  const byPair = new Map<string, Edge>();
  for (const e of list) {
    const key = `${e.from}|${e.to}|${e.tested}`;
    const seen = byPair.get(key);
    if (seen) seen.label = `${seen.label}, ${e.label}`;
    else byPair.set(key, { ...e });
  }
  return [...byPair.values()];
}

function erEdges(): Edge[] {
  const out: Edge[] = [];
  const seen = new Set<string>();
  for (const r of relationships) {
    out.push({ from: r.from, to: r.to, label: r.column, tested: true });
    seen.add(`${r.from}|${r.column}`);
  }
  for (const m of gold) {
    for (const c of m.columns) {
      const target = dimKeys.get(SK_ALIASES[c.name] ?? c.name);
      if (!target || target === m.name || c.name === pkOf(m) || seen.has(`${m.name}|${c.name}`)) continue;
      out.push({ from: m.name, to: target, label: c.name, tested: false });
      seen.add(`${m.name}|${c.name}`);
    }
    const names = new Set(m.columns.map((c) => c.name));
    const hasPlayerSk = names.has('player_sk');
    // Natural keys: league + player id to the player dimension when there is no surrogate key.
    if (!hasPlayerSk && kind(m.name) !== 'dimension' && (names.has('player_id') || names.has('stats_player_id'))) {
      out.push({ from: m.name, to: 'dim_player', label: `league + ${names.has('player_id') ? 'player_id' : 'stats_player_id'}`, tested: false });
    }
    if (kind(m.name) === 'mart' && !names.has('game_sk') && names.has('game_id') && !names.has('player_id')) {
      out.push({ from: m.name, to: 'dim_game', label: 'league + game_id', tested: false });
    }
  }
  return out;
}

function entityLabel(m: Model, fks: Set<string>): string {
  const pk = pkOf(m);
  const keyRows: string[] = [];
  if (pk) keyRows.push(`<B>PK</B> ${esc(pk)}`);
  for (const c of m.columns) if (fks.has(c.name)) keyRows.push(`<B>FK</B> ${esc(c.name)}`);
  const natural = m.columns.filter((c) => NATURAL.includes(c.name)).map((c) => c.name);
  if (natural.length) keyRows.push(`<FONT COLOR="${T.muted}">${esc(natural.join(', '))}</FONT>`);
  const rest = m.columns.length - (pk ? 1 : 0) - fks.size - natural.length;
  const head = kind(m.name) === 'dimension' ? T.goodTint : kind(m.name) === 'fact' ? T.accentTint : T.warnTint;
  return `<<TABLE BORDER="0" CELLBORDER="1" CELLSPACING="0" CELLPADDING="4" COLOR="${T.line}" BGCOLOR="${T.card}">
    <TR><TD BGCOLOR="${head}"><FONT POINT-SIZE="9" COLOR="${T.muted}">«${kind(m.name)}» ${esc(m.materialized)}</FONT><BR/><B>${esc(m.name)}</B></TD></TR>
    <TR><TD ALIGN="LEFT" BALIGN="LEFT">${keyRows.join('<BR/>') || ' '}</TD></TR>
    <TR><TD ALIGN="LEFT"><FONT COLOR="${T.muted}">+ ${rest} more column${rest === 1 ? '' : 's'}</FONT></TD></TR>
  </TABLE>>`;
}

/** Entity-relationship diagram of the gold layer, in UML class notation with crow's feet. */
export function goldEr(): Promise<string> {
  const raw = erEdges();
  const edges = mergeParallel(raw);
  const fksOf = new Map<string, Set<string>>();
  for (const e of raw) if (!e.label.includes(' + ')) (fksOf.get(e.from) ?? fksOf.set(e.from, new Set()).get(e.from))?.add(e.label);
  const nodes = gold
    .map((m) => `"${m.name}" [shape=plain, URL="#m-${m.name}", label=${entityLabel(m, fksOf.get(m.name) ?? new Set())}];`)
    .join('\n');
  // Facts on the left, dimensions in the middle, marts on the right: a mart's edge is drawn from
  // the dimension so it lands on the right, with the crow's foot still on the mart (many) side.
  const rels = edges
    .map((e) => {
      const style = `label="${esc(e.label)}"${e.tested ? '' : ', style=dashed'}`;
      return kind(e.from) === 'mart'
        ? `"${e.to}" -> "${e.from}" [dir=both, arrowtail=tee, arrowhead=crow, ${style}];`
        : `"${e.from}" -> "${e.to}" [dir=both, arrowtail=crow, arrowhead=tee, ${style}];`;
    })
    .join('\n');
  const group = (k: string) => gold.filter((m) => kind(m.name) === k).map((m) => `"${m.name}"`).join('; ');
  return renderDot(`digraph er {
    ${DOT_DEFAULTS}
    rankdir=LR; nodesep=0.35; ranksep=1.1;
    { rank=same; ${group('fact')}; }
    { rank=same; ${group('dimension')}; }
    { rank=same; ${group('mart')}; }
    ${nodes}
    ${rels}
  }`);
}

/** Lineage of every model, by layer, with the seeds. */
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
  const edges = layers.flatMap((l) => l.models.flatMap((m) => m.reads.map((r) => `"${r}" -> "${m.name}";`))).join('\n');
  return renderDot(`digraph lineage {
    ${DOT_DEFAULTS}
    rankdir=LR; nodesep=0.1; ranksep=0.55; concentrate=true; splines=true;
    node [shape=box, style="rounded,filled", fillcolor="${T.card}", fontsize=10, height=0.28, margin="0.08,0.03"];
    edge [arrowsize=0.5, color="${T.line}"];
    subgraph cluster_seeds { label="seeds · ${seeds.length}"; labeljust=l; style="rounded,dashed"; color="${T.line}";
      ${seeds.map((s) => `"${s}" [URL="#seeds", shape=note];`).join(' ')} }
    ${clusters}
    ${edges}
  }`);
}

export const erLegend = 'Solid lines are foreign keys a dbt relationships test enforces; dashed lines are joins on keys no test enforces (surrogate keys, or league plus a natural id). Crow’s feet mark the many side. Facts are on the left, dimensions in the middle, marts on the right; which model is built from which is in the lineage below.';
