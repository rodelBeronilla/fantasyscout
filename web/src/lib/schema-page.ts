/**
 * What the Schema pages read from the dbt project (src/generated/schema.json), and the small
 * helpers they share: the overview at /schema/ lists every model and seed as a row, and each one
 * has its own page at /schema/<name>/ with its notes and columns (#449).
 */
import schema from '../generated/schema.json';
import { href } from './site';

export interface Column {
  name: string;
  type: string;
  description: string;
  tests: string[];
  meta?: { tz?: string; unit?: string; null_when?: string };
}
interface UnitTest {
  name: string;
  description: string;
}
export interface Model {
  name: string;
  materialized: string;
  description: string;
  notes: string[];
  grain: { key: string; columns: string[] } | null;
  landing: string[];
  reads: string[];
  read_by: string[];
  exported_as: string[];
  read_by_pages: string[];
  checks: string[];
  unit_tests: UnitTest[];
  columns: Column[];
}
export interface Seed {
  name: string;
  description: string;
  read_by: string[];
  exported_as: string[];
  columns: Column[];
}

/** A model with its layer, or a seed: what a page at /schema/<name>/ shows. */
export type Entry = (Model & { kind: 'model'; layer: string }) | (Seed & { kind: 'seed' });

export const layers = schema.layers as { name: string; models: Model[] }[];
export const models = layers.flatMap((l) => l.models.map((m) => ({ ...m, kind: 'model' as const, layer: l.name })));
export const seeds = schema.seeds as Seed[];
export const checks = schema.checks as { name: string; severity: string; tags: string[]; about: string; reads: string[] }[];
export const unitTests = schema.unit_tests as { name: string; model: string; description: string }[];
export const landing = schema.landing as { path: string; read_by: string[] }[];
export const sources = schema.sources as { key: string; name: string; host: string; module: string; runner: string; cadence: string; folders: string[] }[];
export const conventions = schema.conventions as { name: string; rule: string }[];
export const genericTests = schema.generic_tests as number;

/** Every model and seed, in the order of the overview. */
export const entries: Entry[] = [...models, ...seeds.map((s) => ({ ...s, kind: 'seed' as const }))];

const seedNames = new Set(seeds.map((s) => s.name));

/** The id of a model's or seed's row on the overview; the diagrams and the Pipeline page link to these. */
export const rowId = (name: string) => (seedNames.has(name) ? `seed-${name}` : `m-${name}`);
/** A model's or seed's row on the overview. */
export const rowHref = (name: string) => href(`/schema/#${rowId(name)}`);
/** A model's or seed's own page. */
export const pageHref = (name: string) => href(`/schema/${name}/`);
/** A data-quality check's row on the overview. */
export const checkHref = (name: string) => href(`/schema/#check-${name}`);
export const docsHref = (name: string) => href(`/docs/#!/model/model.fantasyscout.${name}`);

/** The meta badges of a column: its time zone, unit, or when it is null by design. */
export const badges = (c: Column) =>
  Object.entries(c.meta ?? {}).map(([k, v]) => ({ key: k, text: k === 'tz' ? `tz ${v}` : k === 'unit' ? `${v}` : `null when ${v}` }));
export const described = (cols: Column[]) => cols.filter((c) => c.description.trim()).length;

// "a, b and c"
export const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const numberWords = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
export const count = (n: number) => numberWords[n] ?? String(n);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const grainText = (g: { key: string; columns: string[] }) => `One row per ${list(g.columns)}`;

/** The line under a model's or seed's name: how it is built and what it holds. */
export function summary(e: Entry): string {
  if (e.kind === 'seed') return `seed · ${plural(e.columns.length, 'column')}`;
  return [
    e.materialized,
    plural(e.columns.length, 'column'),
    ...(e.checks.length ? [plural(e.checks.length, 'check')] : []),
    ...(e.unit_tests.length ? [plural(e.unit_tests.length, 'unit test')] : []),
  ].join(' · ');
}

/** How many of a model's columns are described, and whether all of them are. */
export function coverage(e: Entry): { text: string; full: boolean } {
  const doc = described(e.columns);
  return { text: `${doc}/${e.columns.length} described`, full: doc === e.columns.length };
}
