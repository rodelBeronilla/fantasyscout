/** The board's options behind the Filters button: which players, the league's punts, extra columns and the export. */
import { CATEGORIES, CATEGORY_LABELS } from '../lib/format';
import type { BoardAvailability } from '../lib/board-url';
import { Chip } from './ui';

export const select = 'rounded border border-line bg-card px-2 py-1';

export function BoardOptions({
  teams,
  team,
  setTeam,
  availability,
  setAvailability,
  minGames,
  setMinGames,
  minMinutes,
  setMinMinutes,
  rookiesOnly,
  setRookiesOnly,
  movedOnly,
  setMovedOnly,
  watchOnly,
  setWatchOnly,
  watchedCount,
  showPunts,
  punted,
  onTogglePunt,
  cats8,
  scheduleCols,
  setScheduleCols,
  showRange,
  rangeCols,
  setRangeCols,
  showNext7,
  onExport,
}: {
  /** The league's teams, for the team filter. */
  teams: string[];
  team: string;
  setTeam: (team: string) => void;
  availability: BoardAvailability;
  setAvailability: (availability: BoardAvailability) => void;
  minGames: number;
  setMinGames: (games: number) => void;
  minMinutes: number;
  setMinMinutes: (minutes: number) => void;
  rookiesOnly: boolean;
  setRookiesOnly: (on: boolean) => void;
  movedOnly: boolean;
  setMovedOnly: (on: boolean) => void;
  watchOnly: boolean;
  setWatchOnly: (on: boolean) => void;
  /** Players on the watchlist. */
  watchedCount: number;
  /** The punt chips: a value view in a categories league. */
  showPunts: boolean;
  /** The categories that count for nothing: the punts, and turnovers in an 8-category league. */
  punted: Set<string>;
  onTogglePunt: (category: string) => void;
  /** An 8-category league: turnovers do not count, so there is nothing to punt. */
  cats8: boolean;
  scheduleCols: boolean;
  setScheduleCols: (on: boolean) => void;
  /** The consistency columns can be picked: off while consistency is not judged (#761). */
  showRange: boolean;
  rangeCols: boolean;
  setRangeCols: (on: boolean) => void;
  /** The season has games left: the next-7-days and this-week columns. */
  showNext7: boolean;
  onExport: () => void;
}) {
  return (
    <div id="board-options" className="grid gap-4 rounded-lg border border-line bg-card p-3 text-sm md:grid-cols-2" data-testid="board-options">
      <fieldset className="grid content-start gap-2">
        <legend className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Players</legend>
        <div className="flex flex-wrap items-center gap-3">
          <label>
            <span className="sr-only">NBA or WNBA team</span>
            <select value={team} onChange={(e) => setTeam(e.target.value)} className={select} aria-label="Team">
              <option value="">All teams</option>
              {teams.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Health</span>
            <select value={availability} onChange={(e) => setAvailability(e.target.value as BoardAvailability)} className={select} aria-label="Health">
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
            Watchlist only ({watchedCount})
          </label>
        </div>
      </fieldset>
      {showPunts && (
        <fieldset className="grid content-start gap-2">
          <legend className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Punt (your league&apos;s setting)</legend>
          <div className="flex flex-wrap gap-1">
            {CATEGORIES.map((c) => (
              <Chip
                key={c}
                checked={punted.has(c)}
                strike
                onChange={() => onTogglePunt(c)}
                disabled={cats8 && c === 'z_turnovers'}
                title={cats8 && c === 'z_turnovers' ? 'An 8-category league does not count turnovers: there is nothing to punt' : undefined}
              >
                {CATEGORY_LABELS[c]}
              </Chip>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset className="grid content-start gap-2 md:col-span-2">
        <legend className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Columns and export</legend>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={scheduleCols} onChange={(e) => setScheduleCols(e.target.checked)} />
            Schedule and health columns (age, games played{showNext7 ? ', games in the next 7 days and this week' : ''})
          </label>
          {showRange && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={rangeCols} onChange={(e) => setRangeCols(e.target.checked)} />
              Consistency columns (a bad game, a good game, and the spread between games)
            </label>
          )}
          <button type="button" onClick={onExport} className="rounded-full border border-line px-4 py-1 text-sm hover:bg-bg" data-testid="board-csv">
            Export what the board shows as CSV
          </button>
        </div>
      </fieldset>
    </div>
  );
}
