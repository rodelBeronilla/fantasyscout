import { describe, expect, it } from 'vitest';

import { isPreviewHost } from './site';

describe('where Yahoo sign-in works', () => {
  it('is the preview on a workers.dev address, and nowhere else', () => {
    expect(isPreviewHost('fantasyscout-preview.example.workers.dev')).toBe(true);
    expect(isPreviewHost('fantasyscout.beronilla.rodeo')).toBe(false);
    expect(isPreviewHost('127.0.0.1')).toBe(false);
    expect(isPreviewHost('localhost')).toBe(false);
    expect(isPreviewHost('notworkers.dev')).toBe(false);
  });
});
