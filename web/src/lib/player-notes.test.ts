import { describe, expect, it } from 'vitest';

import { fetchPlayerNotes, noteFor, type PlayerNotes } from './player-notes';

const file: PlayerNotes = {
  league: 'nba',
  label: 'AI-written from FantasyScout data and the news',
  model: 'qwen3:8b',
  as_of: '2026-11-08',
  notes: {
    '7': {
      line: 'Out, expected to miss 4.6 games; hold him on the IL.',
      sources: [{ what: 'expected_games_missed', value: '4.6', row_ref: 'mart_board/nba/7/2026-11-08' }],
      injury_status: 'Out',
      news_flag: null,
    },
  },
};

describe('noteFor (#823)', () => {
  const row = { player_id: '7', injury_status: 'Out', news_flag: null };

  it("shows the day's line, and the day after's", () => {
    expect(noteFor(file, row, '2026-11-08')?.line).toBe('Out, expected to miss 4.6 games; hold him on the IL.');
    expect(noteFor(file, row, '2026-11-09')).not.toBeNull();
  });

  it('shows nothing from an older file, a file from the future, or with no file', () => {
    expect(noteFor(file, row, '2026-11-10')).toBeNull();
    expect(noteFor(file, row, '2026-11-07')).toBeNull();
    expect(noteFor(null, row, '2026-11-08')).toBeNull();
  });

  it("shows nothing once the player's listing or news flag has changed, or for another player", () => {
    expect(noteFor(file, { ...row, injury_status: 'Questionable' }, '2026-11-08')).toBeNull();
    expect(noteFor(file, { ...row, news_flag: 'injury' }, '2026-11-08')).toBeNull();
    expect(noteFor(file, { ...row, player_id: '8' }, '2026-11-08')).toBeNull();
    // a missing listing reads as none either way
    expect(noteFor({ ...file, notes: { '7': { ...file.notes['7']!, injury_status: null } } }, { player_id: '7' }, '2026-11-08')).not.toBeNull();
  });
});

describe('fetchPlayerNotes', () => {
  const answer = (body: unknown, init: ResponseInit = {}) =>
    (async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init })) as unknown as typeof fetch;

  it('reads the file, and null when it is missing, not JSON or not notes', async () => {
    expect(await fetchPlayerNotes('nba', answer(file))).toEqual(file);
    expect(await fetchPlayerNotes('nba', answer({}, { status: 404 }))).toBeNull();
    expect(await fetchPlayerNotes('nba', answer({ league: 'nba' }))).toBeNull();
    const html = (async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    expect(await fetchPlayerNotes('nba', html)).toBeNull();
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchPlayerNotes('nba', down)).toBeNull();
  });
});
