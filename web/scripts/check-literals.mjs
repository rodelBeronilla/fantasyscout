// The parameter gate (#765): a decision module may not hold a bare number. Every constant that
// shapes a projection, a probability or a call is registered in methodology/parameters.yml and
// read from src/generated/parameters.ts. A literal is allowed only when it is 0, 1 or -1, or its
// line says why it is not a parameter: `// def:` (mathematics, units, an input bound) or
// `// display:` (how many rows a list shows).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const LIB = join(import.meta.dirname, '..', 'src', 'lib');
// The modules that turn numbers into values, probabilities and calls.
const MODULES = [
  'auction.ts',
  'blowout.ts',
  'board-model.ts',
  'build-plan.ts',
  'buy-sell.ts',
  'il-moves.ts',
  'league-model.ts',
  'league-value.ts',
  'lineup.ts',
  'matchup.ts',
  'punt-chips.ts',
  'roster-upgrades.ts',
  'standings.ts',
  'trade-fairness.ts',
  'trade-impact.ts',
  'trade-suggest.ts',
  'week-value.ts',
];
const ALLOWED = new Set(['0', '1', '-1']);
const MARKED = /\/\/ (def|display): \S/;

const found = [];
for (const name of MODULES) {
  const text = readFileSync(join(LIB, name), 'utf8');
  const lines = text.split('\n');
  const src = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isNumericLiteral(node)) {
      const negative = ts.isPrefixUnaryExpression(node.parent) && node.parent.operator === ts.SyntaxKind.MinusToken;
      const value = (negative ? '-' : '') + node.text;
      const line = src.getLineAndCharacterOfPosition(node.getStart()).line;
      if (!ALLOWED.has(value) && !MARKED.test(lines[line] ?? '')) found.push(`src/lib/${name}:${line + 1}: ${value}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
}
if (found.length) {
  console.error('A number in a decision module must be registered (methodology/parameters.yml) or marked // def: or // display:');
  for (const f of found) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`parameter gate: no unregistered number in ${MODULES.length} decision modules`);
