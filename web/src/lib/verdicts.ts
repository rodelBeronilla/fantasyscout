/**
 * The Methodology page's verdict table (#947): every feature the site shows or hides, from
 * methodology/features.yml, with whether it shows read from the site's switches.
 */
import { FEATURES, PAGES, type Feature } from '../generated/features';
import { PARAMETERS } from '../generated/parameters';
import { SHOWS } from './visibility';

/** The site's switches by key: true shows the feature. */
export const SWITCHES: Readonly<Record<string, boolean>> = SHOWS;

export type Verdict = Feature['verdict'];
export type Shown = 'shown' | 'badged' | 'hidden';

/** The table's order: what passed, what failed, what waits, then the facts. */
export const VERDICTS: readonly Verdict[] = ['validated', 'failed', 'open', 'data'];

export const VERDICT_LABEL: Record<Verdict, string> = {
  validated: 'Validated',
  failed: 'Failed',
  open: 'Not yet judged',
  data: 'Data, no check needed',
};

export const SHOWN_LABEL: Record<Shown, string> = {
  shown: 'Shown',
  badged: 'Shown, badged',
  hidden: 'Hidden',
};

/** Whether a feature shows: its switch decides when it has one, else the list says. */
export function shownOf(f: Feature, switches: Readonly<Record<string, boolean>> = SWITCHES): Shown {
  if (f.switch !== undefined) return switches[f.switch] ? 'shown' : 'hidden';
  return f.shown ?? 'shown';
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "18 January and 15 March 2027": the judging dates, the year once when they share it. */
export function judgingDates(dates: readonly string[]): string {
  const parts = dates.map((d) => {
    const [y, m, day] = d.split('-').map(Number);
    return { y: y!, text: `${day} ${MONTHS[m! - 1]}` };
  });
  const oneYear = parts.every((p) => p.y === parts[0]?.y);
  const texts = parts.map((p, i) => (oneYear && i < parts.length - 1 ? p.text : `${p.text} ${p.y}`));
  return texts.length > 1 ? `${texts.slice(0, -1).join(', ')} and ${texts.at(-1)}` : (texts[0] ?? '');
}

/** When a feature is next judged: its dates when set, after what the list says. */
const nextJudged = (f: Feature): string => (f.dates?.length ? `${f.next}: ${judgingDates(f.dates)}` : f.next);

/** How the registered numbers a feature is built on were set, e.g. "2 measured, 1 assumed". */
function numbersSet(f: Feature): string {
  const status = new Map<string, string>(PARAMETERS.map((p) => [p.id, p.status]));
  const counts = new Map<string, number>();
  for (const id of f.parameters) {
    const s = status.get(id);
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts].map(([s, n]) => `${n} ${s}`).join(', ');
}

/** One row of the table. */
export interface VerdictRow {
  feature: Feature;
  page: { label: string; path?: string };
  shown: Shown;
  numbers: string;
  next: string;
}

/** The table's rows, by verdict in VERDICTS' order and the list's order within each. */
export function verdictRows(features: readonly Feature[] = FEATURES, switches: Readonly<Record<string, boolean>> = SWITCHES): VerdictRow[] {
  return VERDICTS.flatMap((v) =>
    features
      .filter((f) => f.verdict === v)
      .map((f) => ({ feature: f, page: PAGES[f.page] ?? { label: f.page }, shown: shownOf(f, switches), numbers: numbersSet(f), next: nextJudged(f) })),
  );
}
