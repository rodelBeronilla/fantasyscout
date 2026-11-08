import { type LeagueSetup, MAX_PLAYOFF_WEEKS, mondayOf } from '../lib/fantasy-league';

const field = 'rounded border border-line bg-bg px-2 py-1';

/**
 * A head-to-head league's playoffs (#821): the teams that make them, the fantasy weeks they take
 * and the first of those weeks (#874). Without a first week they are the schedule's last, though
 * most hosts end theirs before the NBA's last week. My Team plays the season out for the odds and
 * counts the games in those weeks. An ESPN import or the Yahoo bookmark fills them in from the league.
 */
export function PlayoffSettings({ setup, onChange }: { setup: LeagueSetup; onChange: (change: (s: LeagueSetup) => LeagueSetup) => void }) {
  const imported = setup.source?.playoffWeeks ? (setup.source.host === 'espn' ? 'ESPN sets the weeks at each sync' : 'the Yahoo bookmark set the weeks') : null;
  return (
    <fieldset className="flex flex-wrap items-end gap-3" data-testid="league-playoffs">
      <legend className="mb-1 text-xs text-muted">
        Playoffs: the teams that make them, the fantasy weeks they take and the Monday they start (without one, the season&apos;s last weeks). My Team
        shows your odds of making them and your games in those weeks{imported ? `; ${imported}` : ''}.
      </legend>
      <label className="grid gap-1">
        <span className="text-xs text-muted">Playoff teams</span>
        <input
          type="number"
          min={2}
          max={setup.teams}
          value={setup.playoffs.teams}
          onChange={(e) => {
            const teams = Number(e.target.value);
            if (teams) onChange((s) => ({ ...s, playoffs: { ...s.playoffs, teams } }));
          }}
          className={`${field} w-20`}
          aria-label="Teams that make the playoffs"
        />
      </label>
      <label className="grid gap-1">
        <span className="text-xs text-muted">Playoff weeks</span>
        <input
          type="number"
          min={1}
          max={MAX_PLAYOFF_WEEKS}
          value={setup.playoffs.weeks}
          disabled={!!imported}
          onChange={(e) => {
            const weeks = Number(e.target.value);
            if (weeks) onChange((s) => ({ ...s, playoffs: { ...s.playoffs, weeks } }));
          }}
          className={`${field} w-20`}
          aria-label="Fantasy weeks the playoffs take"
        />
      </label>
      <label className="grid gap-1">
        <span className="text-xs text-muted">First playoff week</span>
        <input
          type="date"
          value={setup.source?.playoffWeeks?.from ?? setup.playoffs.start ?? ''}
          disabled={!!imported}
          onChange={(e) => {
            const start = e.target.value ? mondayOf(e.target.value) : null;
            onChange((s) => ({ ...s, playoffs: { ...s.playoffs, start } }));
          }}
          className={field}
          aria-label="The first playoff week (its Monday)"
          data-testid="playoff-start"
        />
      </label>
    </fieldset>
  );
}
