/**
 * This browser's storage, under one namespace: `fantasyscout:<thing>` and `fantasyscout:<thing>:<league>`.
 * Storage can be missing or blocked (private windows, previews), so every read and write is
 * guarded; a value under an older key is moved to its current key the first time it is read.
 */

const NAMESPACE = 'fantasyscout';

export function storageKey(...parts: string[]): string {
  return [NAMESPACE, ...parts].join(':');
}

/** The raw string under `key`, moving one from `legacyKey` first if that is where it still is. */
export function readRaw(key: string, legacyKey?: string): string | null {
  try {
    let value = window.localStorage.getItem(key);
    if (value === null && legacyKey) {
      value = window.localStorage.getItem(legacyKey);
      if (value !== null) {
        window.localStorage.setItem(key, value);
        window.localStorage.removeItem(legacyKey);
      }
    }
    return value;
  } catch {
    return null;
  }
}

export function writeRaw(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the value lives for this page view
  }
}

export function removeRaw(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
