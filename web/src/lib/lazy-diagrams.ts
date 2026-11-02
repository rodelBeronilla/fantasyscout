/**
 * Puts each diagram a page holds a place for (Diagram.astro with `src`) inline as it comes within
 * `margin` of the viewport (#449). Inline, the drawing follows the theme (the `.dg` rules in
 * global.css) and its links move within the page, which an <img> would not allow. The files are
 * written by this site's own build (src/pages/schema/diagrams/), so their markup is trusted. If a
 * file fails to load, the link to it stays in place.
 */
export function loadDiagramsNearView(margin = '400px'): void {
  const holders = [...document.querySelectorAll<HTMLElement>('[data-diagram-src]')];
  if (!holders.length) return;

  async function load(el: HTMLElement): Promise<void> {
    const src = el.dataset.diagramSrc;
    if (!src) return;
    delete el.dataset.diagramSrc;
    try {
      const res = await fetch(src);
      const svg = res.ok ? await res.text() : '';
      if (svg.trimStart().startsWith('<svg')) {
        el.innerHTML = svg;
        el.dataset.diagramLoaded = '';
      }
    } catch {
      // Offline or blocked: the link to the file is still there.
    }
  }

  if (!('IntersectionObserver' in window)) {
    for (const el of holders) void load(el);
    return;
  }
  const observer = new IntersectionObserver(
    (seen) => {
      for (const entry of seen) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        void load(entry.target as HTMLElement);
      }
    },
    { rootMargin: `${margin} 0px` },
  );
  for (const el of holders) observer.observe(el);
}
