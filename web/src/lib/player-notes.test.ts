import { describe, expect, it } from 'vitest';

import { fetchPlayerNotes, noteFor, notesHealth, type PlayerNote, type PlayerNotes, writtenLabel } from './player-notes';

// written 2026-11-08 at 12:24 Eastern, on an Out listing
const out: PlayerNote = {
  action: 'hold',
  line: 'Out, expected to miss 4.6 games; ranked 58.',
  sources: [
    { what: 'expected_games_missed', value: '4.6', row_ref: 'mart_board/nba/7/2026-11-08' },
    { what: 'rank', value: '58', row_ref: 'mart_board/nba/7/2026-11-08' },
  ],
  written_at: '2026-11-08T17:24:00Z',
  injury_status: 'Out',
  injury_group: 'out',
  news_flag: null,
  news_date: null,
  says: 'sits',
};
const file: PlayerNotes = {
  league: 'nba',
  label: 'AI-written from FantasyScout data and the news',
  model: 'qwen3:8b',
  as_of: '2026-11-08',
  drafted_at: '2026-11-08T17:24:00Z',
  run: { at: '2026-11-08T17:24:00Z', mode: 'daily', flagged: 1, asked: 1, model_away: false },
  notes: { '7': out },
};
const row = { player_id: '7', injury_status: 'Out', injury_group: 'out', news_flag: null, news_date: null, expected_games_missed: 4.6, rank_total: 58 };

describe('noteFor: a line shows while what it was written on holds (#823, #879)', () => {
  it("shows the day's line, and the day after's", () => {
    expect(noteFor(file, row, '2026-11-08')).toEqual({ note: out, state: 'holds', changes: [] });
    expect(noteFor(file, row, '2026-11-09')?.state).toBe('holds');
  });

  it('shows nothing from two days back, from the future, with no file, or for another player', () => {
    expect(noteFor(file, row, '2026-11-10')).toBeNull();
    expect(noteFor(file, row, '2026-11-07')).toBeNull();
    expect(noteFor(null, row, '2026-11-08')).toBeNull();
    expect(noteFor(file, { ...row, player_id: '8' }, '2026-11-08')).toBeNull();
  });

  it('marks a line whose listing changed on the same side, or toward a toss-up', () => {
    const doubtful = noteFor(file, { ...row, injury_status: 'Doubtful', injury_group: 'doubtful' }, '2026-11-08');
    expect(doubtful).toMatchObject({ state: 'changed', changes: ['listed Doubtful (was Out)'] });
    expect(noteFor(file, { ...row, injury_status: 'Questionable', injury_group: 'questionable' }, '2026-11-08')?.state).toBe('changed');
  });

  it('withdraws a line the listing now contradicts: written out, now off the report or probable', () => {
    const back = noteFor(file, { ...row, injury_status: null, injury_group: null }, '2026-11-08');
    expect(back).toMatchObject({ state: 'withdrawn', changes: ['off the injury report (was Out)'] });
    expect(noteFor(file, { ...row, injury_status: 'Probable', injury_group: 'probable' }, '2026-11-08')?.state).toBe('withdrawn');
  });

  it("withdraws a healthy player's line when he is ruled out or inactive on today's lineup", () => {
    const start: PlayerNote = { ...out, action: 'start', injury_status: null, injury_group: null, news_flag: 'role', news_date: '2026-11-07', says: 'plays' };
    const healthy = { ...row, injury_status: null, injury_group: null, news_flag: 'role', news_date: '2026-11-07' };
    const f = { ...file, notes: { '7': start } };
    expect(noteFor(f, healthy, '2026-11-08')?.state).toBe('holds');
    expect(noteFor(f, { ...healthy, injury_status: 'Out', injury_group: 'out' }, '2026-11-08')).toMatchObject({ state: 'withdrawn', changes: ['listed Out (was off the injury report)'] });
    const scratched = noteFor(f, { ...healthy, lineup_role: 'inactive', lineup_date: '2026-11-08' }, '2026-11-08');
    expect(scratched).toMatchObject({ state: 'withdrawn', changes: ["inactive on his team's lineup today"] });
    // yesterday's inactive list is not today's
    expect(noteFor(f, { ...healthy, lineup_role: 'inactive', lineup_date: '2026-11-07' }, '2026-11-08')?.state).toBe('holds');
  });

  it('never withdraws a line that takes no side, such as one citing a return while he is out', () => {
    const f = { ...file, notes: { '7': { ...out, says: null } } };
    expect(noteFor(f, { ...row, injury_status: null, injury_group: null }, '2026-11-08')?.state).toBe('changed');
  });

  it('marks a newer flagged headline, but not one that only aged out of the window', () => {
    expect(noteFor(file, { ...row, news_flag: 'injury', news_date: '2026-11-08' }, '2026-11-08')).toMatchObject({ state: 'changed', changes: ['a newer flagged headline'] });
    const flagged = { ...file, notes: { '7': { ...out, news_flag: 'injury', news_date: '2026-11-06' } } };
    expect(noteFor(flagged, row, '2026-11-08')?.state).toBe('holds');
  });

  it('marks a cited number that moved, at the precision the line wrote it', () => {
    expect(noteFor(file, { ...row, expected_games_missed: 4.62 }, '2026-11-08')?.state).toBe('holds');
    expect(noteFor(file, { ...row, expected_games_missed: 2.1, rank_total: 61 }, '2026-11-08')?.changes).toEqual(['games expected to miss now 2.1 (was 4.6)', 'board rank now 61 (was 58)']);
    const share = { ...file, notes: { '7': { ...out, sources: [{ what: 'availability_share', value: '61%', row_ref: 'r' }] } } };
    expect(noteFor(share, { ...row, availability_multiplier: 0.612 }, '2026-11-08')?.state).toBe('holds');
    expect(noteFor(share, { ...row, availability_multiplier: 0.4 }, '2026-11-08')?.changes).toEqual(['share of games expected to play now 40% (was 61%)']);
    // a row without the number (another page's row) is not read as a change
    expect(noteFor(file, { player_id: '7', injury_status: 'Out', injury_group: 'out' }, '2026-11-08')?.state).toBe('holds');
  });

  it("reads a file from before #879 by its day, and only marks a changed listing", () => {
    const old: PlayerNote = { line: 'Out; miss 4.6 games.', sources: out.sources, injury_status: 'Out', news_flag: null };
    const f = { ...file, drafted_at: undefined, run: undefined, notes: { '7': old } };
    expect(noteFor(f, row, '2026-11-09')?.state).toBe('holds');
    expect(noteFor(f, row, '2026-11-10')).toBeNull();
    expect(noteFor(f, { ...row, injury_status: null, injury_group: null }, '2026-11-08')?.state).toBe('changed');
    expect(noteFor(f, { ...row, news_flag: 'injury' }, '2026-11-08')?.changes).toEqual(['a newer flagged headline']);
  });
});

describe('writtenLabel', () => {
  it('says the Eastern time, with the day when it was not today', () => {
    expect(writtenLabel(out, file, '2026-11-08')).toBe('12:24 ET');
    expect(writtenLabel(out, file, '2026-11-09')).toBe('Nov 8, 12:24 ET');
    expect(writtenLabel({ ...out, written_at: null }, file, '2026-11-08')).toBe('today');
    expect(writtenLabel({ ...out, written_at: null }, file, '2026-11-09')).toBe('Nov 8');
  });
});

describe('notesHealth (#879)', () => {
  const at = new Date('2026-11-09T02:00:00Z');

  it('says when the notes were drafted and how many lines stand', () => {
    expect(notesHealth([['nba', file], ['wnba', null]], at)).toEqual({ tone: 'good', text: 'Player notes drafted Nov 8, 17:24 UTC (lines standing: NBA 1).' });
  });

  it('says the notes were not drafted when the model was away or no daily run drafted them in time', () => {
    const away = { ...file, run: { ...file.run!, at: '2026-11-09T01:10:00Z', mode: 'changed' as const, model_away: true } };
    expect(notesHealth([['nba', away]], at)).toEqual({
      tone: 'warn',
      text: 'Player notes not drafted. NBA: the local model was away at the last run, Nov 9, 01:10 UTC; the lines drafted Nov 8, 17:24 UTC stand until the day after.',
    });
    expect(notesHealth([['nba', file]], new Date('2026-11-10T00:00:00Z')).tone).toBe('warn');
    expect(notesHealth([['nba', { ...file, drafted_at: null }]], at).text).toContain('no daily run has drafted them in time');
    expect(notesHealth([['nba', null]], at)).toEqual({ tone: 'muted', text: 'No player notes have been published yet.' });
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
