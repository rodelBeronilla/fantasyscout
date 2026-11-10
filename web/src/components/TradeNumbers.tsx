/** The numbers under the Trade page's verdict: each player's figures, and the manager's categories before and after. */
import type { League } from '../lib/data';
import { num } from '../lib/board-model';
import { CATEGORY_LABELS, fmt, pct } from '../lib/format';
import type { Worth } from '../lib/league-model';
import { href } from '../lib/site';
import type { TradeImpact } from '../lib/trade-impact';
import { formOf, HOT, profileOf, type TeamChange, type TradePlayer, type TradeSide } from '../lib/trade-players';
import { InjuryTag, injuryDetail, Segmented, Signed, Td, Th } from './ui';

export function TradeNumbers({
  league,
  points,
  complete,
  weekAvailable,
  cats,
  worth,
  giving,
  getting,
  timing,
  numbers,
  onNumbers,
  change,
  impact,
  h2h,
  partnerName,
}: {
  league: League;
  points: boolean;
  /** The season is over: the values project next season. */
  complete: boolean;
  weekAvailable: boolean;
  cats: string[];
  worth: Map<string, Worth>;
  giving: TradeSide;
  getting: TradeSide;
  /** Why the timing is good or bad, a line each. */
  timing: string[];
  /** The table shown: the players or the categories. */
  numbers: 'players' | 'categories';
  onNumbers: (numbers: 'players' | 'categories') => void;
  change: TeamChange | null;
  impact: TradeImpact | null;
  h2h: boolean;
  partnerName: string;
}) {
  /** Whole-percent win chance. */
  const chance = (p: number | undefined) => `${Math.round((p ?? 0) * 100)}%`;

  const playerRow = (p: TradePlayer) => {
    const w = worth.get(p.player_id);
    const form = points ? null : formOf(p, cats);
    const profile = points ? null : profileOf(worth.get(p.player_id)?.cats ?? {}, cats);
    const market = num(p, 'market_rank');
    return (
      <tr key={p.player_id} className="border-t border-line">
        <Td pin="first">
          <span className="flex items-center gap-1 whitespace-nowrap">
            <a href={href(`/p/${league}/${p.player_id}/`)} className="underline-offset-4 hover:underline">
              {p.full_name ?? p.player_id}
            </a>
            <InjuryTag group={p.injury_group} status={p.injury_status} detail={injuryDetail(p)} />
          </span>
        </Td>
        <Td>{p.team_abbreviation ?? '–'}</Td>
        <Td>{p.position ?? '–'}</Td>
        <Td right>{market === null ? '–' : `#${market}`}</Td>
        {!points && (
          <Td right>
            <span
              className={form !== null && form >= HOT ? 'font-semibold text-good' : form !== null && form <= -HOT ? 'font-semibold text-bad' : ''}
              title="Last ten games against the projection, summed over your kept categories"
            >
              {form === null ? '–' : `${form > 0 ? '+' : ''}${fmt(form, 1)}${form >= HOT ? ' hot' : form <= -HOT ? ' cold' : ''}`}
            </span>
          </Td>
        )}
        {!points && (
          <Td>
            <span className="whitespace-nowrap text-xs">
              {profile && profile.best.length > 0 && <span className="text-good">{profile.best.map((c) => CATEGORY_LABELS[c] ?? c).join(' ')}</span>}
              {profile && profile.worst.length > 0 && <span className="text-bad"> · {profile.worst.map((c) => CATEGORY_LABELS[c] ?? c).join(' ')}</span>}
              {profile && !profile.best.length && !profile.worst.length && <span className="text-muted">balanced</span>}
            </span>
          </Td>
        )}
        {!complete && <Td right>{p.games_remaining ?? '–'}</Td>}
        {points && <Td right>{fmt(w?.fpts ?? null)}</Td>}
        <Td right>
          <Signed value={w?.perGame ?? 0} />
        </Td>
        <Td right>{pct(p.games_share)}</Td>
        <Td right>
          <Signed value={w?.season ?? 0} />
        </Td>
        {!complete && <Td right>{pct(p.ros_factor)}</Td>}
        {!complete && (
          <Td right>
            <Signed value={w?.rest ?? 0} />
          </Td>
        )}
        {weekAvailable && <Td right>{p.games_this_week ?? 0}</Td>}
        {weekAvailable && (
          <Td right>
            <Signed value={w?.week ?? 0} />
          </Td>
        )}
      </tr>
    );
  };

  const totalRow = (label: string, s: TradeSide, testid: string) => (
    <tr className="border-t border-line font-semibold" data-testid={testid}>
      <Td>{label}</Td>
      <Td>{''}</Td>
      <Td>{s.players.length ? `${s.players.length} player${s.players.length === 1 ? '' : 's'}` : '–'}</Td>
      <Td right>{''}</Td>
      {!points && <Td right>{''}</Td>}
      {!points && <Td>{''}</Td>}
      {!complete && <Td right>{s.players.reduce((n, p) => n + (p.games_remaining ?? 0), 0)}</Td>}
      {points && <Td right>{''}</Td>}
      <Td right>
        <Signed value={s.perGame} />
      </Td>
      <Td right>{''}</Td>
      <Td right>
        <Signed value={s.season} />
      </Td>
      {!complete && <Td right>{''}</Td>}
      {!complete && (
        <Td right>
          <Signed value={s.rest} />
        </Td>
      )}
      {weekAvailable && <Td right>{s.games}</Td>}
      {weekAvailable && (
        <Td right>
          <Signed value={s.week} />
        </Td>
      )}
    </tr>
  );

  const rankTone = (before: number, after: number) => (after < before ? 'text-good' : after > before ? 'text-bad' : '');
  const chanceTone = (before: number, after: number) => (after - before >= 0.005 ? 'text-good' : before - after >= 0.005 ? 'text-bad' : '');

  return (
    <details className="rounded-lg border border-line bg-card p-3" data-testid="trade-numbers">
      <summary className="cursor-pointer label-caps">
        The numbers: {points ? 'the players' : change ? 'the players and your categories' : 'the players and the categories'}
      </summary>
      {!points && (
        <div className="mt-2">
          <Segmented
            label="The numbers"
            value={numbers}
            options={[
              { id: 'players', label: 'Players' },
              { id: 'categories', label: change ? 'Your categories' : 'Categories' },
            ]}
            onChange={onNumbers}
          />
        </div>
      )}
      <div className={`mt-2 ${numbers === 'players' || points ? '' : 'hidden'}`} id="players">
      <div className="table-scroll overflow-auto" tabIndex={0} role="region" aria-label="The players">
        <table className="w-full text-sm" data-testid="trade-players">
          <thead>
            <tr>
              <Th>Player</Th>
              <Th>Team</Th>
              <Th>Pos</Th>
              <Th right>ESPN</Th>
              {!points && <Th right>Form</Th>}
              {!points && <Th>Strong · weak</Th>}
              {!complete && <Th right>Games left</Th>}
              {points && <Th right>FPts/G</Th>}
              <Th right>Value/G</Th>
              <Th right>Games share</Th>
              <Th right>{complete ? 'Next season' : 'Season'}</Th>
              {!complete && <Th right>Available</Th>}
              {!complete && <Th right>Rest of season</Th>}
              {weekAvailable && <Th right>Games this week</Th>}
              {weekAvailable && <Th right>This week</Th>}
            </tr>
          </thead>
          <tbody>
            {giving.players.map(playerRow)}
            {totalRow('You give', giving, 'total-give')}
            {getting.players.map(playerRow)}
            {totalRow('You get', getting, 'total-get')}
          </tbody>
        </table>
      </div>
      {timing.length > 0 && (
        <ul className="mt-3 grid gap-1 text-sm" data-testid="trade-timing">
          {timing.map((n) => (
            <li key={n} className="flex gap-2">
              <span aria-hidden="true">⏱</span>
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted">
        ESPN: where ESPN&apos;s drafters rank the player. Form: the last ten games against the projection, summed over your kept categories
        (hot or cold past {HOT}). Strong · weak: the player's best categories and worst. Value/G: value per game above your league&apos;s replacement level.
        Games share: the share of the season&apos;s games the player is projected to play.{' '}
        {complete
          ? 'The season is over: Next season counts those games under the projection.'
          : 'Available: the share of the remaining games the player is expected to play. Season and rest of season count those games.'}
      </p>
      </div>
      {!points && (
        <div className={`mt-2 ${numbers === 'categories' ? '' : 'hidden'}`} id="categories">
      <div className="table-scroll overflow-auto" tabIndex={0} role="region" aria-label="Category by category">
        <table className="w-full text-sm" data-testid="trade-categories">
          <thead>
            <tr>
              <Th>Category</Th>
              <Th right>You give</Th>
              <Th right>You get</Th>
              <Th right>Net</Th>
              {change && <Th right>Your team before</Th>}
              {change && <Th right>After</Th>}
              {change && (impact ? <Th right>{h2h ? 'Win chance' : 'Teams beaten'}</Th> : <Th right>Rank of {change.ranked}</Th>)}
              {change && impact && <Th right>{partnerName}&apos;s</Th>}
            </tr>
          </thead>
          <tbody>
            {cats.map((c) => {
              const g = giving.cats[c] ?? 0;
              const r = getting.cats[c] ?? 0;
              const row = change?.rows.find((x) => x.c === c);
              return (
                <tr key={c} className="border-t border-line">
                  <Td>{CATEGORY_LABELS[c] ?? c}</Td>
                  <Td right>
                    <Signed value={g} />
                  </Td>
                  <Td right>
                    <Signed value={r} />
                  </Td>
                  <Td right>
                    <Signed value={r - g} />
                  </Td>
                  {row && (
                    <Td right>
                      <Signed value={impact ? (impact.totals.before[c] ?? 0) : row.before} digits={1} />
                    </Td>
                  )}
                  {row && (
                    <Td right>
                      <Signed value={impact ? (impact.totals.after[c] ?? 0) : row.after} digits={1} />
                    </Td>
                  )}
                  {row && impact && (
                    <Td right>
                      <span className={chanceTone(impact.mine.before[c] ?? 0, impact.mine.after[c] ?? 0)}>
                        {chance(impact.mine.before[c])}
                        {chance(impact.mine.after[c]) !== chance(impact.mine.before[c]) ? ` → ${chance(impact.mine.after[c])}` : ''}
                      </span>
                    </Td>
                  )}
                  {row && impact && (
                    <Td right>
                      <span className={chanceTone(impact.partner.before[c] ?? 0, impact.partner.after[c] ?? 0)}>
                        {chance(impact.partner.before[c])}
                        {chance(impact.partner.after[c]) !== chance(impact.partner.before[c]) ? ` → ${chance(impact.partner.after[c])}` : ''}
                      </span>
                    </Td>
                  )}
                  {row && !impact && (
                    <Td right>
                      <span className={rankTone(row.rankBefore, row.rankAfter)}>
                        {row.rankBefore}
                        {row.rankAfter !== row.rankBefore ? ` → ${row.rankAfter}` : ''}
                      </span>
                    </Td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        Per game above replacement in each category (percentages weighted by attempts).
        {impact
          ? ` Your team’s totals (each player counted by the share of the games left they are expected to play, after any drop or pickup) and your chance of ${
              h2h ? 'winning the category in an average week against your league' : 'finishing ahead of each other team in it'
            }, before and after. A category you already lose or win by a wide margin barely moves; one you are close in can swing.`
          : change
            ? ' Your team’s totals and its rank among the league’s teams, before and after: a trade that drops a category you already lose costs little, and one that lifts a category you are close in can swing it.'
            : ' Set up your league’s rosters to see your team’s totals and ranks before and after.'}
      </p>
        </div>
      )}
    </details>
  );
}
