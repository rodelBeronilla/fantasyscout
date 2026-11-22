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
import { type CallShown, logCall, ownerStatus } from './owner-log';
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

/** A call as the preview logs it: the log adds the date and the build. */
export type PreviewCall = Omit<CallShown, 'date' | 'build'>;

// the Eastern date the call is for, as today.ts reads it, without loading the lineup code for it
const EASTERN = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

// the calls written on this page view, or being written, by what they said: a call is logged once however often it renders
const writes = new Map<string, Promise<boolean>>();

/**
 * A frame's list as the log keeps it: one call for each item shown (a trade, an add, a player), each
 * with its own short subject, and one saying `empty` when the list is empty.
 */
export function eachCall(call: string, items: readonly { subject: string; value: string }[], empty = 'none'): PreviewCall[] {
  return items.length ? items.map((x) => ({ call, ...x, naive: null })) : [{ call, subject: 'none', value: empty, naive: null }];
}

/** The key a call is logged once under: the same call saying the same thing is the same call. */
export const callKey = (c: PreviewCall): string => JSON.stringify([c.call, c.subject, c.value, c.naive]);

/**
 * Logs a call shown in the preview, once a page view. True once the log holds it; false when the
 * log refused it or could not be reached. A call counts as logged only after its write succeeds:
 * a refused one is forgotten, so it is written again when it is next shown (the next page view).
 */
export function logPreviewCall(c: PreviewCall, date: string = EASTERN.format(new Date())): Promise<boolean> {
  const key = callKey(c);
  const known = writes.get(key);
  if (known) return known;
  const write = getLatest()
    .catch(() => null)
    .then((latest) => logCall({ ...c, date, build: latest?.build_id ?? 'unknown' }));
  writes.set(key, write);
  void write.then((ok) => {
    if (!ok) writes.delete(key);
  });
  return write;
}

/**
 * The adds a preview of pickups may offer (#1056): the first `left` of them, with the adds left
 * this week; all of them when the league sets no limit.
 */
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

export function withinAdds<T>(list: readonly T[], left: number | null): T[] {
  return left === null ? [...list] : list.slice(0, Math.max(0, left));
}

/** Whether a preview of pickups has an add to offer: one is left this week, or the league sets no limit. */
export const addsOpen = (left: number | null): boolean => left === null || left > 0;
