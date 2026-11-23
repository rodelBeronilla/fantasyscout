/**
 * The owner preview (#1056): the calls a switch in visibility.ts hides, because they failed their
 * check or are not judged yet, shown to the signed-in owner alone, each one logged to his private
 * log (owner-log.ts). Two things must both hold: the owner has turned the preview on in this
 * browser (the account box's "Your data"), and the Worker says this browser holds the owner's
 * cookie. The flag owner.ts keeps is a hint only and never enough. A browser with the preview
 * off, which is every browser but one, asks nothing and renders the public page unchanged.
 */
import { useEffect, useState } from 'react';

import { getLatest } from './data';
import { BATCH_LIMITS, CALL_LIMITS, callKey } from '../../../worker/src/owner-log-event';
import { logCalls, ownerStatus } from './owner-log';
import { readRaw, removeRaw, storageKey, writeRaw } from './storage';

/** Where this browser keeps the switch; it is per browser, like the league kept here. */
export const PREVIEW_KEY = storageKey('owner-preview');

/** Whether the switch is on in this browser. It shows nothing on its own: the Worker must agree. */
export function previewSwitchOn(): boolean {
  return readRaw(PREVIEW_KEY) === 'on';
}

export function setPreviewSwitch(on: boolean): void {
  if (on) writeRaw(PREVIEW_KEY, 'on');
  else removeRaw(PREVIEW_KEY);
}

/** Whether to show the preview: the switch on, then the Worker asked. With the switch off, no request. */
export function ownerPreviewOn(): Promise<boolean> {
  return previewSwitchOn() ? ownerStatus() : Promise.resolve(false);
}

/** The preview, for a component: false until the Worker has said yes, so the first paint is the public page's. */
export function useOwnerPreview(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void ownerPreviewOn().then((yes) => live && setOn(yes));
    return () => {
      live = false;
    };
  }, []);
  return on;
}

/** A call as a frame shows it: the log adds the day, the build and the league's import. */
export interface PreviewCall {
  /** The kind of call, lower-case words joined by hyphens. */
  call: string;
  /** What the call is about: player ids, a trade, a move. */
  subject: string;
  /** What the call said. */
  value: string | number;
  /** What the naive manager would have said; null where there is no naive answer. */
  naive: string | number | null;
}

// the Eastern date the call is for, as today.ts reads it, without loading the lineup code for it
const EASTERN = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** A text within `max` characters, never empty: `empty` says what an empty one means. */
export function fitText(text: string, max: number, empty = 'none'): string {
  const t = text.trim() || empty.trim() || 'none';
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * A list within `max` characters: whole items joined by `sep`, then "(+N more)" for those left out,
 * so a cut list says what it left out; `empty` when there are none.
 */
export function fitList(items: readonly string[], max: number, empty = 'none', sep = ' '): string {
  if (items.length === 0) return fitText('', max, empty);
  for (let n = items.length; n > 0; n -= 1) {
    const text = items.slice(0, n).join(sep) + (n < items.length ? ` (+${items.length - n} more)` : '');
    if (text.length <= max) return text;
  }
  return fitText(`${items.length} items, the first too long to name`, max);
}

/** A trade as a subject, "give > get", each side cut to its half of the limit, so both sides always show. */
export function tradeSubject(give: readonly string[], get: readonly string[], prefix = ''): string {
  const half = Math.floor((CALL_LIMITS.subject - prefix.length - 3) / 2);
  return `${prefix}${fitList(give, half, 'nothing')} > ${fitList(get, CALL_LIMITS.subject - prefix.length - 3 - half, 'nothing')}`;
}

type Part = string | number | readonly string[];
const fitPart = (v: Part, max: number, empty: string): string | number =>
  typeof v === 'number' ? (Number.isFinite(v) ? v : fitText('', max, empty)) : typeof v === 'string' ? fitText(v, max, empty) : fitList(v, max, empty);

/**
 * The one way a frame builds a call (#1056): within the log's limits whatever the league, so the
 * Worker never refuses it. A list is cut to what fits with a count of what was left out, and an
 * empty subject or value says what it means (`empty`).
 */
export function previewCall(c: { call: string; subject: Part; value: Part; naive?: Part | null; empty?: string }): PreviewCall {
  const empty = c.empty ?? 'none';
  return {
    // a name the log takes: lower-case words and hyphens, cut without an ellipsis
    call: c.call.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, CALL_LIMITS.call) || 'call',
    subject: String(fitPart(c.subject, CALL_LIMITS.subject, 'none')),
    value: fitPart(c.value, CALL_LIMITS.value, empty),
    naive: c.naive === undefined || c.naive === null ? null : fitPart(c.naive, CALL_LIMITS.value, 'none'),
  };
}

/**
 * A frame's list as the log keeps it: one call for each item shown (a trade, an add, a player),
 * each with its own short subject, and one saying `empty` when the list is empty.
 */
export function eachCall(call: string, items: readonly { subject: Part; value: Part }[], empty = 'none'): PreviewCall[] {
  return items.length ? items.map((x) => previewCall({ call, ...x })) : [previewCall({ call, subject: 'none', value: empty })];
}

/**
 * What a list cut by the adds left holds back (#1056): one call saying how many were held back and
 * why, so a grader does not read a list cut by the limit as the model finding fewer. Null when nothing was.
 */
export function heldBack(call: string, found: number, shown: number, left: number | null): PreviewCall | null {
  if (found <= shown) return null;
  return previewCall({
    call,
    subject: 'held back',
    value: shown === 0 ? `all ${found} held back: no adds left this week` : `${found - shown} more held back by the adds limit (${left ?? 0} left this week)`,
  });
}

/** The league's import a call was made for, as the log keys it: host, league and import time, or "none" for a league entered by hand. */
export function importOf(source: { host: string; leagueId: string; syncedAt: number } | undefined): string {
  if (!source) return 'none';
  // the import time last, so a long league id is what is cut
  const time = `:${source.syncedAt}`;
  return `${`${source.host}:${source.leagueId}`.replace(/[^\w.:-]/g, '-').slice(0, CALL_LIMITS.league - time.length)}${time}`;
}

/** A call as the log stores it. */
type Entry = PreviewCall & { date: string; build: string; league: string };

// def: how long the page's calls stay unchanged before they are sent, together, in one request: the
// frames of a page appear as its data arrives, and a call drawn while its data is still coming is
// replaced before it is ever sent, so it is never logged or shown
export const SETTLE_MS = 2000;

// this page view's calls: waiting to be sent, being sent, and answered (true: the log holds it)
const waiting = new Map<string, { entry: Entry; waiters: Set<(ok: boolean) => void> }>();
const sending = new Map<string, Promise<boolean>>();
const answered = new Map<string, boolean>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function send(): Promise<void> {
  timer = null;
  const batch = [...waiting.entries()];
  waiting.clear();
  if (batch.length === 0) return;
  const latest = await getLatest().catch(() => null);
  const id = latest?.build_id ?? '';
  const build = /^[\w.:-]+$/.test(id) && id.length <= CALL_LIMITS.build ? id : 'unknown';
  for (let i = 0; i < batch.length; i += BATCH_LIMITS.calls) {
    const chunk = batch.slice(i, i + BATCH_LIMITS.calls);
    const entries = chunk.map(([, w]) => ({ ...w.entry, build }));
    const written = logCalls(entries);
    chunk.forEach(([key], k) => sending.set(key, written.then((results) => results?.[k] === 'stored' || results?.[k] === 'kept')));
    for (const [key, w] of chunk) {
      const ok = await sending.get(key)!;
      answered.set(key, ok);
      sending.delete(key);
      w.waiters.forEach((done) => done(ok));
    }
  }
}

/**
 * Logs a frame's calls before it shows them (#1056): they wait SETTLE_MS with the page's other
 * calls, go to the log in one request, and `done` says, call by call, whether the log holds each
 * (stored now, or already from this day's earlier view or another tab). A call refused or not
 * answered is not tried again on this page view; the next one tries again. `cancel` withdraws calls
 * not yet sent, when the frame comes to show something else.
 */
export function logBeforeShowing(calls: readonly PreviewCall[], league: string, date: string = EASTERN.format(new Date())): { done: Promise<boolean[]>; cancel: () => void } {
  const withdraw: (() => void)[] = [];
  const done = Promise.all(
    calls.map((c) => {
      const entry: Entry = { ...c, date, league, build: '' };
      const key = callKey(entry);
      const known = answered.get(key);
      if (known !== undefined) return Promise.resolve(known);
      const inFlight = sending.get(key);
      if (inFlight) return inFlight;
      return new Promise<boolean>((resolve) => {
        const w = waiting.get(key) ?? { entry, waiters: new Set<(ok: boolean) => void>() };
        w.waiters.add(resolve);
        waiting.set(key, w);
        withdraw.push(() => {
          w.waiters.delete(resolve);
          if (w.waiters.size === 0 && waiting.get(key) === w) waiting.delete(key);
        });
      });
    }),
  );
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => void send(), SETTLE_MS);
  return { done, cancel: () => withdraw.forEach((w) => w()) };
}

/**
 * Whether the league's adds a week and its waiver wait are known (#1056). A value that is set, typed
 * on the League page or read by an import, is known. An empty one means "no limit" only where the
 * import read Yahoo's settings page (or the league is not a Yahoo copy); on a Yahoo copy imported
 * before the bookmark read that page, an empty value means "not known".
 */
export function limitsKnown(setup: {
  addsPerWeek?: number | null;
  waiverDays?: number | null;
  source?: { host?: string; rules?: object };
}): { adds: boolean; waiver: boolean } {
  const read = setup.source?.host !== 'yahoo' || !!setup.source.rules;
  return { adds: read || (setup.addsPerWeek ?? null) !== null, waiver: read || (setup.waiverDays ?? null) !== null };
}

/**
 * The adds a preview of pickups may offer (#1056): the first `left` of them, with the adds left
 * this week; all of them when the league sets no limit.
 */
export function withinAdds<T>(list: readonly T[], left: number | null): T[] {
  return left === null ? [...list] : list.slice(0, Math.max(0, left));
}

/** Whether a preview of pickups has an add to offer: one is left this week, or the league sets no limit. */
export const addsOpen = (left: number | null): boolean => left === null || left > 0;
