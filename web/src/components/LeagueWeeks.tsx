/**
 * The league, week by week (#1054): every team's rank in each category against the league,
 * for a chosen week or the season so far, from the totals Yahoo scored. Facts: no projection.
 */
import { useMemo, useState } from 'react';

import { CATEGORIES, CATEGORY_LABELS } from '../lib/format';
import type { LeagueSetup } from '../lib/fantasy-league';
import { type LeagueWeek, missingWeeks, seasonTable, showTotal, weekTable } from '../lib/league-weeks';

const record = (r: { won: number; lost: number; tied: number }) => `${r.won}-${r.lost}${r.tied ? `-${r.tied}` : ''}`;
const share = (r: { won: number; lost: number; tied: number }) => {
  const n = r.won + r.lost + r.tied;
  return n ? (r.won + r.tied / 2) / n : 0;
};

/** A list in words: "A", "A and B", "A, B and C". */
const inWords = (xs: (string | number)[]) => (xs.length === 1 ? String(xs[0]) : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** A rank's tone: the top two and the bottom two of the league stand out. */
function tone(rank: number | null, teams: number): string {
  if (rank === null) return 'text-muted';
  if (rank <= 2) return 'bg-good/15 text-good font-semibold';
  if (rank > teams - 2) return 'bg-bad/15 text-bad font-semibold';
  return '';
}

export function LeagueWeeks({ setup, weeks }: { setup: LeagueSetup; weeks: LeagueWeek[] }) {
  const sorted = useMemo(() => [...weeks].sort((a, b) => a.week - b.week), [weeks]);
  const [chosen, setChosen] = useState<number | 'season'>(() => sorted.at(-1)?.week ?? 'season');
  const cats = CATEGORIES.filter((c) => setup.scoring !== 'cats8' || c !== 'z_turnovers');
  const name = (t: number) => setup.names[t] ?? `Team ${t + 1}`;
  const found = chosen === 'season' ? null : sorted.find((w) => w.week === chosen) ?? null;
  // every team has a row, a team Yahoo gave no totals for included (#1064)
  const week = useMemo(() => (found ? { ...found, teams: Array.from({ length: Math.max(setup.teams, found.teams.length) }, (_, t) => found.teams[t] ?? null) } : null), [found, setup.teams]);
  const rows = useMemo(() => (week ? weekTable(week, cats).sort((a, b) => share(b.allPlay) - share(a.allPlay)) : []), [week, cats]);
  const season = useMemo(
    () => (chosen === 'season' ? seasonTable(sorted, setup.teams, cats).sort((a, b) => share(b.allPlay) - share(a.allPlay)) : []),
    [chosen, sorted, setup.teams, cats],
  );
  const finished = sorted.filter((w) => w.final).length;
  // the teams with no totals in the week shown, or in a finished week for the season (#1064)
  const gaps = missingWeeks(week ? [week] : sorted.filter((w) => w.final), setup.teams);
  const gapLines = week
    ? gaps.length
      ? [
          `Yahoo gave no totals for ${inWords(gaps.map((g) => name(g.team)))} in week ${week.week}, so ${gaps.length === 1 ? 'it has' : 'they have'} no ranks that week and the other teams' all-play counts ${setup.teams - 1 - gaps.length} opponents, not ${setup.teams - 1}.`,
        ]
      : []
    : gaps.map(
        (g) =>
          `Yahoo gave no totals for ${name(g.team)} in ${g.weeks.length === 1 ? 'week' : 'weeks'} ${inWords(g.weeks)}: its averages and all-play are over ${finished - g.weeks.length} finished ${finished - g.weeks.length === 1 ? 'week' : 'weeks'}, not ${finished}.`,
      );
  const [top, bottom] = [`1 or 2`, `${setup.teams - 1} or ${setup.teams}`];
  const key =
    chosen === 'season'
      ? `Rows run from the best all-play record to the worst, a tie counting half. Green marks an average rank that rounds to ${top}, red one that rounds to ${bottom}.`
      : `Rows run from the best all-play record to the worst, a tie counting half. Green marks a rank of ${top}, red a rank of ${bottom}.`;
  const pill = (active: boolean) =>
    `shrink-0 rounded-full border px-3 py-1 text-sm ${active ? 'border-accent bg-accent font-semibold text-accent-fg' : 'border-line text-muted hover:text-fg'}`;
  const cell = 'px-1.5 py-1.5 text-center tabular-nums';

  return (
    <section className="rounded-lg border border-line bg-card p-3" aria-labelledby="weeks-h" data-testid="league-weeks">
      <h2 id="weeks-h" className="label-caps">
        The league, week by week
      </h2>
      <p className="mt-1 text-sm text-muted">
        Every team&apos;s rank in each category, against the league, from the totals Yahoo scored. 1 is the best; ties share a rank; turnovers
        rank fewest first.
      </p>
      <p className="mt-1 text-xs text-muted" data-testid="weeks-key">
        {key}
      </p>
      <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Week shown">
        <button type="button" aria-pressed={chosen === 'season'} className={pill(chosen === 'season')} onClick={() => setChosen('season')}>
          Season
        </button>
        {/* the newest week first, beside Season, so the week shown is in view on a phone */}
        {[...sorted].reverse().map((w) => (
          <button key={w.week} type="button" aria-pressed={chosen === w.week} className={pill(chosen === w.week)} onClick={() => setChosen(w.week)}>
            Wk {w.week}
            {!w.final && <span className="sr-only"> (so far)</span>}
            {!w.final && <span aria-hidden="true">*</span>}
          </button>
        ))}
      </div>
      {week && !week.final && <p className="mt-1 text-xs text-muted">* Week {week.week} is still being played: its totals are the score so far.</p>}
      {gapLines.map((line) => (
        <p key={line} className="mt-1 text-xs text-muted" data-testid="weeks-missing">
          {line}
        </p>
      ))}
      {chosen === 'season' && finished === 0 && (
        <p className="mt-2 text-sm text-muted" data-testid="weeks-none-final">
          No week has finished yet: the season&apos;s ranks start with the first finished week.
        </p>
      )}

      <div className="table-scroll mt-2 overflow-auto" tabIndex={0} role="region" aria-label={chosen === 'season' ? 'Season ranks by category' : `Week ${chosen} ranks by category`}>
        <table className="w-full text-sm" data-testid="weeks-table">
          <thead>
            <tr>
              <th scope="col" className="pin px-2 py-2 text-left text-[11px] font-semibold tracking-wider text-muted uppercase">
                Team
              </th>
              <th scope="col" className="px-1.5 py-2 text-center text-[11px] font-semibold tracking-wider whitespace-nowrap text-muted uppercase" title="Each category against each other team: won, lost, tied">
                All-play
              </th>
              {cats.map((c) => (
                <th key={c} scope="col" className="px-1.5 py-2 text-center text-[11px] font-semibold tracking-wider text-muted uppercase">
                  {CATEGORY_LABELS[c] ?? c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {chosen !== 'season'
              ? rows.map((r) => (
                  <tr key={r.team} className="border-t border-line" data-mine={r.team === setup.mine || undefined} data-testid="weeks-row">
                    <th scope="row" className="pin max-w-28 truncate px-2 py-1.5 text-left font-medium" title={name(r.team)}>
                      <span className="block truncate">{name(r.team)}</span>
                      {r.team === setup.mine && <span className="block text-[11px] leading-tight font-normal text-muted">you</span>}
                    </th>
                    <td className={`${cell} whitespace-nowrap`}>{week?.teams[r.team] ? record(r.allPlay) : '–'}</td>
                    {cats.map((c) => (
                      <td key={c} className={`${cell} rounded ${tone(r.ranks[c] ?? null, setup.teams)}`} data-cat={c}>
                        <span className="block text-base leading-tight">{r.ranks[c] ?? '–'}</span>
                        <span className="block text-[11px] leading-tight text-muted">{showTotal(c, r.values[c] ?? null)}</span>
                      </td>
                    ))}
                  </tr>
                ))
              : season.map((r) => (
                  <tr key={r.team} className="border-t border-line" data-mine={r.team === setup.mine || undefined} data-testid="weeks-row">
                    <th scope="row" className="pin max-w-28 truncate px-2 py-1.5 text-left font-medium" title={name(r.team)}>
                      <span className="block truncate">{name(r.team)}</span>
                      {r.team === setup.mine && <span className="block text-[11px] leading-tight font-normal text-muted">you</span>}
                    </th>
                    <td className={`${cell} whitespace-nowrap`}>{record(r.allPlay)}</td>
                    {cats.map((c) => {
                      const avg = r.average[c] ?? null;
                      const move = r.move[c] ?? null;
                      return (
                        <td key={c} className={`${cell} rounded ${tone(avg === null ? null : Math.round(avg), setup.teams)}`} data-cat={c}>
                          <span className="block text-base leading-tight">{avg === null ? '–' : avg.toFixed(1)}</span>
                          {/* the arrow is seen; its word is what a screen reader reads (#1064) */}
                          <span className="block text-[11px] leading-tight text-muted">
                            {move ? (
                              <>
                                <span aria-hidden="true">{move === 'rising' ? '↑' : '↓'}</span>
                                <span className="sr-only">{move}</span>
                              </>
                            ) : (
                              ' '
                            )}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        {chosen === 'season'
          ? `The average rank over the ${finished} finished ${finished === 1 ? 'week' : 'weeks'}; an arrow when the last three weeks are half a rank or more better (↑) or worse (↓). All-play adds every finished week's.`
          : 'All-play: each category against each of the other teams, won, lost or tied, as the league counts its records. Percentages come from the makes and attempts.'}
      </p>
    </section>
  );
}
