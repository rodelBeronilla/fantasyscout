import type { ReactNode } from 'react';

import { NoBuildError } from '../lib/data';

export function Loading({ what }: { what: string }) {
  return (
    <p className="text-muted" role="status" aria-live="polite">
      Loading {what}…
    </p>
  );
}

export function Problem({ error }: { error: unknown }) {
  if (error instanceof NoBuildError) {
    return (
      <div className="rounded-lg border border-line bg-card p-4" role="status">
        <p className="font-medium">No data build has been published yet.</p>
        <p className="mt-1 text-sm text-muted">
          The nightly build publishes after every passing quality gate. Until the first one lands, the
          pages have nothing to show.
        </p>
      </div>
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-lg border border-line bg-card p-4" role="alert">
      <p className="font-medium">Could not load this page's data.</p>
      <p className="mt-1 text-sm text-muted">{message}</p>
    </div>
  );
}

export function Card({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="rounded-lg border border-line bg-card p-4" aria-labelledby={id ? `${id}-h` : undefined}>
      <h2 id={id ? `${id}-h` : undefined} className="text-sm font-medium tracking-wide text-muted uppercase">
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function Th({ children, right = false }: { children: ReactNode; right?: boolean }) {
  return (
    <th scope="col" className={`px-2 py-1.5 text-xs font-medium whitespace-nowrap text-muted ${right ? 'text-right' : 'text-left'}`}>
      {children}
    </th>
  );
}

export function Td({ children, right = false, mono = false }: { children: ReactNode; right?: boolean; mono?: boolean }) {
  return (
    <td className={`px-2 py-1.5 whitespace-nowrap ${right ? 'text-right tabular-nums' : ''} ${mono ? 'font-mono text-xs' : ''}`}>
      {children}
    </td>
  );
}

/** A positive or negative figure, coloured by sign. */
export function Signed({ value, digits = 2 }: { value: number | null | undefined; digits?: number }) {
  if (value === null || value === undefined || Number.isNaN(value)) return <span className="text-muted">–</span>;
  const text = value.toFixed(digits);
  const cls = value > 0.05 ? 'text-good' : value < -0.05 ? 'text-bad' : '';
  return <span className={cls}>{value > 0 ? `+${text}` : text}</span>;
}

export function Badge({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'muted'; children: ReactNode }) {
  // Outlined, not tinted: tinted backgrounds fail the AA contrast ratio at this size.
  const cls = {
    good: 'border-good text-good',
    warn: 'border-warn text-warn',
    bad: 'border-bad text-bad',
    muted: 'border-line text-muted',
  }[tone];
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}
