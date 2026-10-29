/**
 * Diagrams rendered to static SVG when the site is built: Graphviz (compiled to WebAssembly)
 * for flow, deployment, activity, entity-relationship and lineage diagrams, and a small layout
 * of our own for sequence diagrams. Nothing runs in the browser.
 *
 * Colours are written as placeholder values (TOKEN) and styled by `.dg` rules in global.css,
 * so the diagrams follow the light and dark themes and the content security policy needs no
 * inline styles: CSS rules beat SVG presentation attributes.
 */
import { Graphviz } from '@hpcc-js/wasm-graphviz';

export const TOKEN = {
  card: '#fffff0',
  bg: '#fffff1',
  accentTint: '#fffff2',
  goodTint: '#fffff3',
  warnTint: '#fffff4',
  line: '#000010',
  fg: '#000011',
  muted: '#000012',
  accent: '#000013',
  good: '#000014',
  warn: '#000015',
} as const;

let engine: Promise<Graphviz> | null = null;

/** Graph-wide defaults: one font, the theme's text and line colours, no background. */
export const DOT_DEFAULTS = `
  bgcolor="transparent";
  fontname="Helvetica,Arial,sans-serif"; fontsize=12; fontcolor="${TOKEN.fg}";
  node [fontname="Helvetica,Arial,sans-serif", fontsize=11, fontcolor="${TOKEN.fg}", color="${TOKEN.line}", fillcolor="${TOKEN.card}", style=filled, penwidth=1.2, margin="0.16,0.07"];
  edge [fontname="Helvetica,Arial,sans-serif", fontsize=10, fontcolor="${TOKEN.muted}", color="${TOKEN.muted}", arrowsize=0.7, penwidth=1.1];
`;

/** A DOT graph as an SVG string, sized in points, with Graphviz's header and comments removed. */
export async function renderDot(dot: string): Promise<string> {
  engine ??= Graphviz.load();
  const svg = (await engine).dot(dot);
  return svg
    .replace(/^[\s\S]*?(<svg\b)/, '$1')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<svg\b/, '<svg class="dg" focusable="false"')
    .replace(/<polygon fill="(?:white|transparent)" stroke="none"[^>]*\/>/, '')
    // SVG 2 links: plain href, which every current browser follows and selectors match.
    .replace(/ xlink:href=/g, ' href=');
}

/** Escape text for a DOT string or an HTML-like label. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface Participant {
  id: string;
  label: string;
  sub?: string;
}

export type Step =
  | { kind: 'call' | 'reply' | 'async'; from: string; to: string; text: string }
  | { kind: 'self'; at: string; text: string }
  | { kind: 'note'; over: string[]; text: string }
  | { kind: 'alt'; text: string; steps: Step[] };

/**
 * A UML sequence diagram: participants across the top, lifelines down, one row per message.
 * Calls are solid with a filled head, replies dashed with an open head, async messages solid
 * with an open head; `alt` draws a guarded fragment around its steps.
 */
export function sequenceSvg(participants: Participant[], steps: Step[]): string {
  const colW = 120;
  const left = 16;
  const top = 58;
  const rowH = 34;
  const x = new Map(participants.map((p, i) => [p.id, left + colW / 2 + i * colW]));
  const width = left * 2 + colW * participants.length;
  const parts: string[] = [];
  let y = top + 20;

  const t = (tx: number, ty: number, text: string, cls: string, anchor = 'middle') =>
    `<text x="${tx}" y="${ty}" text-anchor="${anchor}" class="${cls}">${esc(text)}</text>`;

  const draw = (list: Step[], depth: number) => {
    for (const s of list) {
      if (s.kind === 'alt') {
        const y0 = y - 14;
        y += 12;
        const inner = parts.length;
        draw(s.steps, depth + 1);
        const x0 = left + 4 + depth * 6;
        const x1 = width - left - 4 - depth * 6;
        parts.splice(
          inner,
          0,
          `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y - y0 - 8}" fill="none" stroke="${TOKEN.muted}" stroke-dasharray="4 3"/>`,
          `<rect x="${x0}" y="${y0}" width="${Math.max(60, s.text.length * 5.6 + 40)}" height="16" fill="${TOKEN.accentTint}" stroke="${TOKEN.muted}"/>`,
          t(x0 + 6, y0 + 12, `alt [${s.text}]`, 'dg-small', 'start'),
        );
        y += 4;
        continue;
      }
      if (s.kind === 'note') {
        const xs = s.over.map((id) => x.get(id) ?? 0);
        const x0 = Math.min(...xs) - colW / 2 + 8;
        const x1 = Math.max(...xs) + colW / 2 - 8;
        parts.push(`<rect x="${x0}" y="${y - 13}" width="${x1 - x0}" height="20" rx="3" fill="${TOKEN.warnTint}" stroke="${TOKEN.line}"/>`);
        parts.push(t((x0 + x1) / 2, y + 1, s.text, 'dg-small'));
        y += rowH - 6;
        continue;
      }
      if (s.kind === 'self') {
        const sx = x.get(s.at) ?? 0;
        parts.push(`<path d="M${sx},${y - 6} h26 v14 h-22" fill="none" stroke="${TOKEN.fg}" marker-end="url(#seq-open)"/>`);
        parts.push(t(sx + 32, y + 2, s.text, 'dg-msg', 'start'));
        y += rowH;
        continue;
      }
      const fx = x.get(s.from) ?? 0;
      const tx = x.get(s.to) ?? 0;
      const dir = tx >= fx ? 1 : -1;
      const marker = s.kind === 'call' ? 'seq-solid' : 'seq-open';
      const dash = s.kind === 'reply' ? ' stroke-dasharray="5 4"' : '';
      parts.push(`<line x1="${fx}" y1="${y}" x2="${tx - dir * 2}" y2="${y}" stroke="${TOKEN.fg}"${dash} marker-end="url(#${marker})"/>`);
      parts.push(t((fx + tx) / 2, y - 5, s.text, 'dg-msg'));
      y += rowH;
    }
  };
  draw(steps, 0);
  const height = y + 10;

  const heads = participants
    .map((p) => {
      const cx = x.get(p.id) ?? 0;
      return [
        `<rect x="${cx - colW / 2 + 6}" y="8" width="${colW - 12}" height="38" rx="4" fill="${TOKEN.card}" stroke="${TOKEN.line}"/>`,
        t(cx, 24, p.label, 'dg-head'),
        p.sub ? t(cx, 38, p.sub, 'dg-small') : '',
        `<line x1="${cx}" y1="46" x2="${cx}" y2="${height - 4}" stroke="${TOKEN.line}" stroke-dasharray="3 4"/>`,
      ].join('');
    })
    .join('');

  return [
    `<svg class="dg dg-seq" focusable="false" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`,
    '<defs>',
    `<marker id="seq-solid" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${TOKEN.fg}"/></marker>`,
    `<marker id="seq-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10" fill="none" stroke="${TOKEN.fg}"/></marker>`,
    '</defs>',
    heads,
    parts.join(''),
    '</svg>',
  ].join('');
}
