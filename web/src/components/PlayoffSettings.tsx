import { type LeagueSetup, MAX_PLAYOFF_WEEKS } from '../lib/fantasy-league';

const field = 'rounded border border-line bg-bg px-2 py-1';

/**
 * A head-to-head league's playoffs (#821): the teams that make them and the weeks they take, the
 * schedule's last. My Team plays the season out for the odds and counts the games in those weeks.
 * An ESPN import fills both in from the league.
 */
export function PlayoffSettings({ setup, onChange }: { setup: LeagueSetup; onChange: (change: (s: LeagueSetup) => LeagueSetup) => void }) {
  const espn = setup.source?.host === 'espn' && !!setup.source.playoffWeeks;
  return (
    <fieldset className="flex flex-wrap items-end gap-3" data-testid="league-playoffs">
      <legend className="mb-1 text-xs text-muted">
        Playoffs: the teams that make them and the fantasy weeks they take, the season&apos;s last. My Team shows your odds of making them and your games in
        those weeks{espn ? '; ESPN sets the weeks at each sync' : ''}.
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
          disabled={espn}
          onChange={(e) => {
            const weeks = Number(e.target.value);
            if (weeks) onChange((s) => ({ ...s, playoffs: { ...s.playoffs, weeks } }));
          }}
          className={`${field} w-20`}
          aria-label="Fantasy weeks the playoffs take"
        />
      </label>
    </fieldset>
  );
}
