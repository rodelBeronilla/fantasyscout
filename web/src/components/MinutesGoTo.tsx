import type { League } from '../lib/data';
import { type Gainer, gainerDetail, gainerNote, type MinutesCall } from '../lib/minutes-go-to';
import { href } from '../lib/site';

const button = 'rounded border border-line px-1.5 text-xs hover:bg-bg';

/**
 * Who takes an out player's minutes (#820): "Minutes go to Brown (+8, 41% rostered): add him" when
 * the top gainer is free in the manager's league; "Minutes go to Brown (+8, on Team 4)" when he is
 * taken, with the best gainer still free after it. `onAdd` makes "add him" a move on the league
 * copy (the IL row pairs it with the IL move); without it, the link opens the player's page.
 */
export function MinutesGoTo({
  call,
  player,
  league,
  mine,
  teamName,
  onAdd,
}: {
  call: MinutesCall;
  /** The out player's name, for the hover text. */
  player: string;
  league: League;
  mine: number;
  teamName: (t: number) => string;
  onAdd?: (id: string) => void;
}) {
  const verb = league === 'wnba' ? 'add her' : 'add him';
  const who = (g: Gainer) => (
    <a href={href(`/p/${league}/${g.id}/`)} className="font-medium underline-offset-4 hover:underline" title={gainerDetail(g, player)}>
      {g.name}
    </a>
  );
  const add = (g: Gainer) =>
    onAdd ? (
      <button type="button" className={button} onClick={() => onAdd(g.id)} data-testid="minutes-add">
        {verb}
      </button>
    ) : (
      <a href={href(`/p/${league}/${g.id}/`)} className="text-accent underline-offset-4 hover:underline" data-testid="minutes-add">
        {verb}
      </a>
    );
  const { top, pickup } = call;
  return (
    <span className="text-xs" data-testid="minutes-go-to">
      Minutes go to {who(top)} ({gainerNote(top, teamName, mine)})
      {pickup?.id === top.id ? <>: {add(top)}</> : null}
      {pickup && pickup.id !== top.id ? (
        <>
          ; free: {who(pickup)} ({gainerNote(pickup, teamName, mine)}): {add(pickup)}
        </>
      ) : null}
    </span>
  );
}
