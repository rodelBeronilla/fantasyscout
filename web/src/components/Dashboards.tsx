import { useEffect, useState } from 'react';

import { buildHref, getLatest, type Latest } from '../lib/data';
import { Loading, Problem } from './ui';

const FILES = [
  ['team_pace_ratings.csv', 'Team pace and ratings, one row per team-season'],
  ['player_value.csv', 'Player value on the board, one row per player'],
  ['data_health.csv', 'Data health, one row per build'],
] as const;

/** The embed URL comes from the deploy (PUBLIC_TABLEAU_VIZ_URL); empty until the workbook is published. */
export default function Dashboards({ vizUrl }: { vizUrl: string }) {
  const [latest, setLatest] = useState<Latest | null | undefined>(undefined);
  const [available, setAvailable] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const l = await getLatest();
      if (!live) return;
      setLatest(l);
      if (!l) return;
      const r = await fetch(buildHref(l, 'tableau/index.json'));
      if (r.ok) {
        const index = (await r.json()) as { files: string[] };
        if (live) setAvailable(new Set(index.files));
      }
    })().catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, []);

  const embed = vizUrl ? `${vizUrl}?:embed=y&:showVizHome=no&:toolbar=bottom` : '';

  return (
    <div className="grid gap-6">
      {embed ? (
        <iframe
          src={embed}
          title="League Pulse, a Tableau Public workbook"
          className="h-[80vh] w-full rounded-lg border border-line bg-card"
          loading="lazy"
          data-testid="tableau-embed"
        />
      ) : (
        <div className="rounded-lg border border-line bg-card p-4" data-testid="tableau-pending">
          <p className="font-medium">The League Pulse workbook is not published yet.</p>
          <p className="mt-1 text-sm text-muted">
            Tableau Public has no publishing API, so the workbook is created once by hand from the extract
            below, which every build also pushes into a Google Sheet that Tableau Public re-reads daily; the
            repository&apos;s <code>tableau/README.md</code> has the steps. Once the viz URL is set, it appears here.
          </p>
        </div>
      )}
      <section>
        <h2 className="text-sm font-medium tracking-wide text-muted uppercase">The extract behind it</h2>
        {error ? <Problem error={error} /> : null}
        {latest === undefined && <Loading what="the extract list" />}
        {latest !== undefined && (
          <ul className="mt-2 grid gap-2 text-sm" data-testid="tableau-files">
            {FILES.map(([file, blurb]) => (
              <li key={file} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-1">
                <span>
                  <code>{file}</code> <span className="text-muted">{blurb}</span>
                </span>
                {latest && available.has(file) ? (
                  <a href={buildHref(latest, `tableau/${file}`)} className="underline underline-offset-4" download>
                    Download
                  </a>
                ) : (
                  <span className="text-muted">not in this build yet</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
