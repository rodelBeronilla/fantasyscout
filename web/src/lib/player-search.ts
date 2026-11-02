import { nameKey } from './fantasy-league';

/**
 * The option labels that match what was typed, in the order given (the board's, best first):
 * every word typed appears in the label, accents, case and punctuation aside (#454). So "luka"
 * finds "Luka Dončić · DAL · G" and "doncic dal" does too.
 */
export function matchOptions(labels: readonly string[], text: string, limit = 8): string[] {
  const words = nameKey(text).split(' ').filter(Boolean);
  if (!words.length) return [];
  const out: string[] = [];
  for (const label of labels) {
    const key = nameKey(label);
    if (words.every((w) => key.includes(w))) {
      out.push(label);
      if (out.length >= limit) break;
    }
  }
  return out;
}
