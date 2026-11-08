import type { ReactNode } from 'react';

import { gamesText, recordText, type Standing, standingLine } from '../lib/records';
import { Td, Th, Tile, Unvalidated } from './ui';

/**
 * The league's real standings at the top of My Team (#822): the manager's place and how far back
 * of the team above and of first, from ESPN's or Yahoo's records at the last import, or the records
 * entered on the League page (#874). The whole table, and the projected power rankings, are one
 * click down.
 */
export function Standings({
  table,
  mine,
  names,
  power,
  from,
}: {
  table: Standing[];
  mine: number;
  names: string[];
  power: ReactNode;
  /** Where the records came from, e.g. "from ESPN at the last sync". */
  from: string;
}) {
  const line = standingLine(table, mine);
  const me = table.find((s) => s.team === mine);
  return (
    <Tile title="Standings" id="standings" testid="standings">
      {line && me && (
        <p className="mt-1 text-sm" data-testid="standing-line">
          <strong>{line}</strong> <span className="text-muted">({recordText(me.record)}, {from})</span>
        </p>
      )}
      <details className="mt-2 text-sm" data-testid="standings-all">
        <summary className="cursor-pointer text-xs text-muted">The whole league</summary>
        <div className="table-scroll mt-2 overflow-auto" tabIndex={0} role="region" aria-label="Standings">
          <table className="w-full text-sm" data-testid="standings-table">
            <thead>
              <tr>
                <Th right>#</Th>
                <Th>Team</Th>
                <Th right>
                  <span title="Won, lost and tied, as the league counts them: matchups, or categories in a league that scores each one">W-L-T</span>
                </Th>
                <Th right>
                  <span title="Games back of first: half the gap in wins plus half the gap in losses">GB</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {table.map((s) => (
                <tr key={s.team} className={`border-t border-line ${s.team === mine ? 'font-semibold' : ''}`} data-testid="standing-row">
                  <Td right>{s.place}</Td>
                  <Td>{names[s.team] ?? `Team ${s.team + 1}`}</Td>
                  <Td right>{recordText(s.record)}</Td>
                  <Td right>
                    <span title={s.back > 0 ? `${gamesText(s.back)} back` : undefined}>{s.back > 0 ? s.back : '–'}</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {power && (
        <details className="mt-2 text-sm" data-testid="power-details">
          <summary className="cursor-pointer text-xs text-muted">
            Power rankings: the teams by what their rosters project to win
            <Unvalidated issue={867} what="Power rankings" />
          </summary>
          {power}
        </details>
      )}
    </Tile>
  );
}
