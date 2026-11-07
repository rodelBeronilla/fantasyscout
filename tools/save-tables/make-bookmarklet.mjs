// Prints the bookmarklet: a javascript: URL to paste as a bookmark's address (#792).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dirname, 'save-tables.js'), 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');
console.log(`javascript:${encodeURIComponent(source)}`);
