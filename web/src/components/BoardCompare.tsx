/** The board's compare panel: up to four players side by side, the best figure in each row in bold. */
import { CATEGORIES, CATEGORY_LABELS, fmt, pct } from '../lib/format';
import type { BoardView } from '../lib/board-url';
import { isLine, num, zKey } from '../lib/board-model';
import { LINE, VIEWS } from '../lib/board-views';
import { Signed, Td, Th } from './ui';

export const COMPARE_MAX = 4;

/** What the compare panel reads of a board row. */
interface CompareRow {
  player_id: string;
  full_name: string | null;
  value_total: number | null;
  games_share: number | null;
  [key: string]: unknown;
}

export function BoardCompare({
  compared,
  view,
  punted,
  leagueCats,
  valueOf,
  onClear,
}: {
  compared: CompareRow[];
  view: BoardView;
  punted: Set<string>;
  /** Category values above the league's replacement level; null in a points league. */
  leagueCats: Map<string, Record<string, number>> | null;
  /** Each player's value in the current view. */
  valueOf: Map<string, number | null>;
  onClear: () => void;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-line bg-card p-3" aria-labelledby="compare-h" data-testid="compare">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="compare-h" className="label-caps">
          Compare ({compared.length}/{COMPARE_MAX})
        </h2>
        <button type="button" onClick={onClear} className="rounded-full border border-line px-3 py-0.5 text-xs hover:bg-bg">
          Clear
        </button>
      </div>
      <div className="table-scroll mt-2 max-h-[70vh] overflow-auto" tabIndex={0} role="region" aria-label="Player comparison">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <Th>{isLine(view) ? 'Value view' : (VIEWS.find((v) => v.id === view)?.label ?? '')}</Th>
              {compared.map((r) => (
                <Th key={r.player_id} right>
                  {r.full_name}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              ...CATEGORIES.map((c) => ({
                label: CATEGORY_LABELS[c] ?? c,
                get: (r: CompareRow) => (punted.has(c) ? null : (leagueCats?.get(r.player_id)?.[c] ?? num(r, zKey(isLine(view) ? 'value' : view, c)))),
                kind: 'z',
              })),
              { label: 'Total', get: (r: CompareRow) => (isLine(view) ? r.value_total : (valueOf.get(r.player_id) ?? null)), kind: 'z' },
              { label: 'GP%', get: (r: CompareRow) => r.games_share, kind: 'pct' },
              ...LINE.map((l) => ({ label: `${l.label} (proj)`, get: (r: CompareRow) => num(r, `proj_${l.key}`), kind: l.kind })),
            ].map((m) => {
              const values = compared.map((r) => m.get(r));
              const better = m.label.startsWith('TO (') ? Math.min : Math.max;
              const known = values.filter((v): v is number => typeof v === 'number');
              const best = known.length > 1 ? better(...known) : null;
              return (
                <tr key={m.label} className="border-t border-line">
                  <Td>{m.label}</Td>
                  {values.map((v, i) => (
                    <Td key={compared[i]?.player_id} right>
                      <span className={best !== null && v === best ? 'font-semibold' : ''}>
                        {m.kind === 'z' ? <Signed value={v} /> : m.kind === 'pct' ? pct(v) : fmt(v)}
                      </span>
                    </Td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
