import type { ReactNode } from 'react';

import { DataUnavailableError, NoBuildError } from '../lib/data';
import { day, easternClock } from '../lib/format';
import { easternDate } from '../lib/today';
import { REPO_URL } from '../lib/site';
import { SHOWS } from '../lib/visibility';

export function Loading({ what }: { what: string }) {
  return (
    <p className="text-muted" role="status" aria-live="polite">
      Loading {what}…
    </p>
  );
}

export function Problem({ error }: { error: unknown }) {
  if (error instanceof DataUnavailableError) {
    return (
      <div className="rounded-lg border border-line bg-card p-4" role="alert" data-testid="data-unavailable">
        <p className="font-medium">{error.message}</p>
        <p className="mt-1 text-sm text-muted">
          The published data could not be read just now. It is still there: reload in a moment.
        </p>
        <button type="button" className="mt-2 rounded-full border border-line px-4 py-1 text-sm" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
  if (error instanceof NoBuildError) {
    return (
      <div className="rounded-lg border border-line bg-card p-4" role="status">
        <p className="font-medium">No data build has been published yet.</p>
        <p className="mt-1 text-sm text-muted">
          The nightly build publishes after every passing quality gate. Until the first one lands, the
          pages have nothing to show.
        </p>
      </div>
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-lg border border-line bg-card p-4" role="alert">
      <p className="font-medium">Could not load this page's data.</p>
      <p className="mt-1 text-sm text-muted">{message}</p>
    </div>
  );
}

/**
 * A feature not yet backtested out of sample (#751): it links to the issue that will validate it,
 * and comes off when the feature passes, or the feature does when it fails.
 */
export function Unvalidated({ issue, what, label = 'Not yet validated' }: { issue: number; what?: string; label?: string }) {
  return (
    <a
      href={`${REPO_URL}/issues/${issue}`}
      target="_blank"
      rel="noopener"
      className="ml-2 inline-block rounded border border-warn px-1 align-middle text-[10px] font-medium tracking-normal text-warn normal-case hover:underline"
      title={`${what ?? 'This'} has not yet been backtested out of sample. The issue says how it will be tested; until then, treat it as a guide.`}
      data-testid="unvalidated"
    >
      {label}
    </a>
  );
}

/** A card on My Team: a heading, and what it holds; `issue` adds the "Not yet validated" badge. */
export function Tile({ title, id, children, testid, issue }: { title: string; id: string; children: ReactNode; testid?: string; issue?: number }) {
  return (
    <section className="min-w-0 rounded-lg border border-line bg-card p-3" aria-labelledby={`${id}-h`} data-testid={testid}>
      <h2 id={`${id}-h`} className="label-caps">
        {title}
        {issue && <Unvalidated issue={issue} what={title} />}
      </h2>
      {children}
    </section>
  );
}

export function Card({ title, children, id, badge }: { title: string; children: ReactNode; id?: string; badge?: ReactNode }) {
  return (
    <section id={id} className="min-w-0 rounded-lg border border-line bg-card p-4" aria-labelledby={id ? `${id}-h` : undefined}>
      <h2 id={id ? `${id}-h` : undefined} className="label-caps">
        {title}
        {badge}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** The sticky-column classes for a cell that names the row (#437): the first pinned cell, or the second beside a narrow first. */
const pinClass = (pin?: Pin) => (pin === 'first' ? 'pin' : pin === 'second' ? 'pin pin-second' : '');
export type Pin = 'first' | 'second';

export function Th({ children, right = false, pin }: { children: ReactNode; right?: boolean; pin?: Pin }) {
  return (
    <th scope="col" className={`px-2 py-2 text-[11px] font-semibold tracking-wider whitespace-nowrap text-muted uppercase ${right ? 'text-right' : 'text-left'} ${pinClass(pin)}`}>
      {children}
    </th>
  );
}

export function Td({ children, right = false, mono = false, pin, col }: { children: ReactNode; right?: boolean; mono?: boolean; pin?: Pin; col?: string }) {
  return (
    <td data-col={col} className={`px-2 py-1.5 whitespace-nowrap ${right ? 'text-right tabular-nums' : ''} ${mono ? 'font-mono text-xs' : ''} ${pinClass(pin)}`}>
      {children}
    </td>
  );
}

/** A positive or negative figure, coloured by sign. */
export function Signed({ value, digits = 2 }: { value: number | null | undefined; digits?: number }) {
  if (value === null || value === undefined || Number.isNaN(value)) return <span className="text-muted">–</span>;
  const text = value.toFixed(digits);
  const cls = value > 0.05 ? 'text-good' : value < -0.05 ? 'text-bad' : '';
  return <span className={cls}>{value > 0 ? `+${text}` : text}</span>;
}

export function Badge({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'muted'; children: ReactNode }) {
  // Outlined, not tinted: tinted backgrounds fail the AA contrast ratio at this size.
  const cls = {
    good: 'border-good text-good',
    warn: 'border-warn text-warn',
    bad: 'border-bad text-bad',
    muted: 'border-line text-muted',
  }[tone];
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

/** An injury tag next to a player's name; the note and expected return go in the tooltip. */
export function InjuryTag({
  group,
  status,
  detail,
}: {
  group: string | null | undefined;
  status: string | null | undefined;
  detail?: string | null;
}) {
  if (!group) return null;
  const label = { out: 'OUT', doubtful: 'DOUBT', questionable: 'Q', probable: 'PROB', day_to_day: 'DTD' }[group] ?? 'INJ';
  const tone = group === 'out' ? 'border-bad text-bad' : 'border-warn text-warn';
  return (
    <span
      className={`ml-1.5 inline-block rounded border px-1 text-[10px] font-semibold leading-4 ${tone}`}
      title={[status, detail].filter(Boolean).join(' · ')}
      data-testid="injury-tag"
    >
      {label}
    </span>
  );
}

/** A clickable column header that shows the current sort. */
export function SortTh({
  children,
  active,
  dir,
  onClick,
  right = false,
  pin,
  title,
}: {
  children: ReactNode;
  active: boolean;
  dir: 'asc' | 'desc';
  onClick: () => void;
  right?: boolean;
  pin?: Pin;
  title?: string;
}) {
  return (
    <th
      scope="col"
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`px-2 py-2 text-[11px] font-semibold tracking-wider whitespace-nowrap uppercase ${right ? 'text-right' : 'text-left'} ${pinClass(pin)}`}
    >
      <button
        type="button"
        onClick={onClick}
        title={title}
        // At least 24 by 24 to tap (#457); the negative margin keeps the header row's height.
        className={`-my-1 inline-block min-h-6 min-w-6 py-1 tracking-wider uppercase underline-offset-4 hover:underline ${active ? 'text-fg' : 'text-muted'}`}
      >
        {children}
        {active ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  );
}

/** A row of toggle chips (position letters, categories). */
export function Chip({
  checked,
  onChange,
  children,
  label,
  strike = false,
  disabled = false,
  title,
}: {
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
  label?: string;
  /** Strike the label through while checked: the chip removes something (a punted category). */
  strike?: boolean;
  /** A chip that cannot change in this context, with the reason as its title (#460). */
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label
      title={title}
      className={`flex items-center rounded-full border px-2.5 py-1 text-sm select-none has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
      } ${checked ? 'border-accent bg-accent text-accent-fg' : 'border-line'} ${checked && strike ? 'line-through decoration-2' : ''}`}
    >
      <input type="checkbox" className="sr-only" checked={checked} onChange={onChange} aria-label={label} disabled={disabled} />
      {children}
    </label>
  );
}

/** A short explanatory banner (season state). */
export function Note({ children, testid }: { children: ReactNode; testid?: string }) {
  return (
    <p className="rounded-lg border border-line bg-card px-3 py-2 text-sm text-muted" data-testid={testid}>
      {children}
    </p>
  );
}

/** A player whose current team differs from last season's: the projection leans on this season's role. */
export function NewTeam({ from }: { from: string | null | undefined }) {
  return (
    <span
      className="rounded border border-accent px-1 text-[10px] text-accent"
      title={`New team${from ? `: was on ${from} last season` : ''}. Minutes from seasons on another team count for less.`}
      data-testid="new-team"
    >
      NEW{from ? ` · ${from}` : ''}
    </span>
  );
}

/** A watchlist toggle: a star button that says what it does and whether it is on. */
export function Star({ on, label, onToggle }: { on: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? `Remove ${label} from the watchlist` : `Add ${label} to the watchlist`}
      title={on ? 'On your watchlist' : 'Add to your watchlist'}
      onClick={onToggle}
      // The glyph is 12 by 14; the padding makes the tap target 28 by 30 without moving the name (#457).
      className={`-m-2 p-2 leading-none ${on ? 'text-warn' : 'text-muted hover:text-fg'}`}
      data-testid="watch"
    >
      {on ? '★' : '☆'}
    </button>
  );
}

// Built once (#557): a formatter per call cost a slow phone a tenth of a second across the board's rows.
const LINEUP_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });

/** The day a lineup role is for: "today", or the weekday and date of the next game day. */
export function lineupDay(date: string | null | undefined): string {
  if (!date) return 'today';
  if (date === easternDate()) return 'today';
  return LINEUP_DAY.format(new Date(`${date}T12:00:00Z`));
}

/** The weekday of a lineup's game day for a tag ("TODAY", "THU"). */
function lineupDayShort(date: string | null | undefined): string {
  const when = lineupDay(date);
  if (when === 'today') return 'TODAY';
  return WEEKDAY.format(new Date(`${date}T12:00:00Z`)).toUpperCase();
}

/**
 * The role from the league's starting lineups (NBA) for the next game day: starting, or listed
 * inactive by the team (not in uniform: an injury, a G League assignment or the coach's decision).
 * A player already tagged OUT on the injury report gets no second tag.
 */
export function LineupTag({
  role,
  confirmed,
  date,
  injuryGroup,
}: {
  role: string | null | undefined;
  confirmed: boolean | null | undefined;
  date?: string | null;
  injuryGroup?: string | null;
}) {
  const when = lineupDay(date);
  if (role === 'starter') {
    return (
      <span
        className={`rounded border px-1 text-[10px] font-semibold ${confirmed ? 'border-good bg-good text-bg' : 'border-good text-good'}`}
        title={confirmed ? `Starting ${when}: confirmed by the team` : `Expected to start ${when} (not yet confirmed)`}
        data-testid="lineup-tag"
      >
        {confirmed ? 'START' : 'START?'}
      </span>
    );
  }
  if (role === 'inactive' && injuryGroup !== 'out') {
    return (
      <span
        className="rounded border border-bad px-1 text-[10px] font-semibold text-bad"
        title={`Not playing ${when}: the team listed the player inactive (not in uniform), for an injury, a G League assignment or the coach's decision`}
        data-testid="lineup-tag"
      >
        OUT {lineupDayShort(date)}
      </span>
    );
  }
  return null;
}

/** What each tag beside a player's name means. */
export function TagLegend() {
  return (
    <details className="text-xs text-muted" data-testid="tag-legend">
      <summary className="cursor-pointer py-1 select-none">What the tags mean</summary>
      <dl className="mt-1 grid gap-x-3 gap-y-0.5 sm:grid-cols-[auto_1fr]">
        <dt className="font-semibold">START / START?</dt>
        <dd>Starting the next game day: confirmed by the team, or expected (NBA lineups).</dd>
        <dt className="font-semibold">OUT TODAY / OUT THU</dt>
        <dd>The team listed the player inactive for that game: not in uniform.</dd>
        <dt className="font-semibold">OUT, DOUBT, Q, PROB, DTD</dt>
        <dd>Injury status: the league&apos;s official report for the next game, else ESPN&apos;s listing (hover for detail).</dd>
        <dt className="font-semibold">REST?</dt>
        <dd>The team has nothing left to play for late in the season: minutes are less certain.</dd>
        <dt className="font-semibold">BLOWOUT?</dt>
        <dd>A starter whose next game has a spread of 10 points or more: starters sit more of a lopsided game (hover for the minutes).</dd>
        <dt className="font-semibold">TOP OUT</dt>
        <dd>The team&apos;s largest-usage player is out for the next game on the official report: teammates usually get more minutes (hover for who).</dd>
        <dt className="font-semibold">NEW</dt>
        <dd>On a new team this season.</dd>
        <dt className="font-semibold">BACK, NEWS, SURG, MIN LIM, ROLE, G LG, SEASON</dt>
        <dd>A flagged ESPN headline about the player in the last three days (hover for it).</dd>
        <dt className="font-semibold">▲ / ▼</dt>
        <dd>Rising or falling in ESPN leagues (ownership up or down a point or more).</dd>
      </dl>
    </details>
  );
}

/** The fields behind an injury tag's tooltip, on any page's row. */
export interface InjuryFields {
  injury_type?: string | null;
  injury_since?: string | null;
  expected_return?: string | null;
  injury_news?: string | null;
  injury_note?: string | null;
  injury_source?: string | null;
  official_game_date?: string | null;
  official_report_at?: string | null;
  /** Games the player is expected to miss, from past listings with the same status (board only). */
  expected_games_missed?: number | null;
}

/** An injury tag's tooltip: whose report, the injury, since when, the expected return and the note. */
export function injuryDetail(row: InjuryFields): string {
  return [
    row.injury_source === 'official' && row.official_game_date
      ? `Official report for ${day(row.official_game_date)}${row.official_report_at ? ` (${easternClock(row.official_report_at)} ET)` : ''}`
      : row.injury_source === 'espn'
        ? "ESPN's injury listing"
        : null,
    row.injury_type,
    row.injury_since ? `since ${day(row.injury_since)}` : null,
    row.expected_return ? `return ${day(row.expected_return)}` : null,
    // the games-missed estimate is not judged (SHOWS.injuryEstimate): the report's own return date only
    SHOWS.injuryEstimate && typeof row.expected_games_missed === 'number' && !row.expected_return
      ? `players listed like this missed ${row.expected_games_missed.toFixed(1)} games on average`
      : null,
    row.injury_news || row.injury_note,
  ]
    .filter(Boolean)
    .join(' · ');
}

const NEWS_TAGS: Record<string, { label: string; tone: string }> = {
  out_for_season: { label: 'SEASON', tone: 'border-bad text-bad' },
  surgery: { label: 'SURG', tone: 'border-bad text-bad' },
  injury: { label: 'NEWS', tone: 'border-warn text-warn' },
  minutes_limit: { label: 'MIN LIM', tone: 'border-warn text-warn' },
  return: { label: 'BACK', tone: 'border-good text-good' },
  g_league: { label: 'G LG', tone: 'border-line text-muted' },
  role: { label: 'ROLE', tone: 'border-line text-muted' },
};

/** The newest flagged ESPN headline about the player in the last three days, the headline in the tooltip. */
export function NewsTag({ flag, headline, date }: { flag: string | null | undefined; headline?: string | null; date?: string | null }) {
  if (!flag) return null;
  const tag = NEWS_TAGS[flag] ?? { label: 'NEWS', tone: 'border-line text-muted' };
  return (
    <span
      className={`rounded border px-1 text-[10px] font-semibold ${tag.tone}`}
      title={[date ? day(date) : null, headline].filter(Boolean).join(': ') + ' (ESPN)'}
      data-testid="news-tag"
    >
      {tag.label}
    </span>
  );
}

/** ESPN ownership moving a point or more: rising or falling across ESPN leagues. */
export function TrendTag({ trend }: { trend: string | null | undefined }) {
  if (trend !== 'rising' && trend !== 'falling') return null;
  const up = trend === 'rising';
  return (
    <span
      className={up ? 'text-good' : 'text-bad'}
      title={up ? 'Rising in ESPN leagues: rostered in a point or more of them than before' : 'Falling in ESPN leagues: dropped from a point or more of them'}
      data-testid="trend-tag"
    >
      {up ? '▲' : '▼'}
    </span>
  );
}

/** A player whose team has nothing left to play for in the last stretch: minutes are less certain. */
export function RestRiskTag({ risk, stakes }: { risk: boolean | null | undefined; stakes?: string | null }) {
  if (!risk) return null;
  const why =
    stakes === 'clinched'
      ? 'The team has clinched a playoff place with few games left: regulars may rest'
      : stakes === 'eliminated'
        ? 'The team is eliminated with few games left: minutes may go to young players'
        : 'The team has nothing left to play for with few games left: minutes are less certain';
  return (
    <span className="rounded border border-warn px-1 text-[10px] font-semibold text-warn" title={why} data-testid="rest-risk">
      REST?
    </span>
  );
}

/** A starter whose next game is lopsided on the betting line (#486): a flag, not a change of value. */
export function BlowoutTag({ risk }: { risk: { spread: number; minutes: number } | null }) {
  if (!risk) return null;
  const title = `Next game's spread is ${risk.spread} points: starters play about ${risk.minutes.toFixed(1)} fewer minutes in a game this lopsided (game context notebook)`;
  return (
    <span className="rounded border border-warn px-1 text-[10px] font-semibold text-warn" title={title} data-testid="blowout">
      BLOWOUT?
    </span>
  );
}

/**
 * The team's largest-usage player is out for the next game (#485): their teammates' minutes and
 * production go up (notebook 07: about +2.2 minutes and +2.3 fantasy points a game per 10 points of
 * usage share out, for players at the same position). A flag; the value is unchanged (ADR 0012).
 */
export function TopOutTag({ name, usage }: { name: string | null | undefined; usage: number | null | undefined }) {
  if (!name) return null;
  const share = typeof usage === 'number' ? ` (${Math.round(usage * 100)}% of the team's possessions)` : '';
  return (
    <span
      className="rounded border border-good px-1 text-[10px] font-semibold text-good"
      title={`${name}${share} is out for the next game on the official report: teammates usually play and produce more (teammate absence notebook)`}
      data-testid="top-out"
    >
      TOP OUT
    </span>
  );
}

/** A row of buttons for one choice among a few, announced as a radiogroup. */
export function Segmented<T extends string>({
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
    <div className="inline-flex flex-wrap rounded-[1.25rem] border border-line bg-card p-1" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          title={o.title}
          onClick={() => onChange(o.id)}
          className={`rounded-full px-3 py-1 text-sm ${value === o.id ? 'bg-accent font-semibold text-accent-fg' : 'text-muted hover:text-fg'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
