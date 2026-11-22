// Fixtures from the owner's Yahoo pages, scrubbed (#1030):
//
//   node scripts/yahoo-fixtures.mjs ../private/yahoo-pages-<id>-<date>.json [out-dir] [extra-names.txt]
//
// The capture bookmark saves the pages the import read as one file on the owner's device; it goes
// in the repository's ignored private/ folder. This writes each page to out-dir (by default
// tests/fixtures/data/yahoo-real/) with the team names, the manager names and the league id
// replaced (src/lib/yahoo-scrub.ts). extra-names.txt, also kept in private/, lists any other string
// to replace, one a line. Nothing is written if any original string would be left in a fixture.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fixtureName, leftovers, namesIn, replacements, scrub } from '../src/lib/yahoo-scrub.ts';

const [file, out = 'tests/fixtures/data/yahoo-real', extraFile] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/yahoo-fixtures.mjs <capture.json> [out-dir] [extra-names.txt]');
  process.exit(2);
}
const capture = JSON.parse(readFileSync(file, 'utf8'));
const extra = extraFile ? readFileSync(extraFile, 'utf8').split(/\r?\n/) : [];
const names = namesIn(capture, extra);
const pairs = replacements(names);
const taken = new Set();
const written = capture.pages.map((p) => ({ name: fixtureName(p.url, capture.leagueId, taken), html: scrub(p.html, capture.leagueId, pairs) }));
const left = leftovers(
  written.map((w) => w.name + '\n' + w.html),
  capture.leagueId,
  [...names.teams, ...names.managers],
);
if (left.length) {
  // the originals are not printed: only how many, so the log names nobody
  console.error(`refused: ${left.length} original string(s) would be left in the fixtures; nothing written`);
  process.exit(1);
}
mkdirSync(out, { recursive: true });
for (const w of written) writeFileSync(join(out, w.name), w.html);
console.log(`wrote ${written.length} pages to ${out}: ${names.teams.length} team names and ${names.managers.length} manager names replaced, league id as ${'12345'}`);
