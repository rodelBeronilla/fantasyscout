import { useEffect, useState } from 'react';

import { markFirstRow } from './data';

/**
 * A page's first rows paint before the rest (#436, #562): false until the browser is idle after
 * the data arrives, so a slow phone draws the top of the page in one short task and the rest of
 * the first page of rows in the next. Marks fs:first-row, the deploy's slow-phone budget.
 */
export function useWarmUp(ready: boolean): boolean {
  const [warm, setWarm] = useState(false);
  useEffect(() => {
    if (!ready) return;
    markFirstRow();
    if (warm) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => setWarm(true), { timeout: 1500 });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(() => setWarm(true), 200);
    return () => window.clearTimeout(id);
  }, [ready, warm]);
  return warm;
}
