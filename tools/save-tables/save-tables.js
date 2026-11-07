// Save tables (#792): the tables of the page open in your browser, as one JSON file.
//
// A bookmarklet for the owner's own research. It reads only what the page already shows you, in
// your own tab, and sends no request of its own: no crawling, no challenge answered for you. The
// file goes to your downloads; `fs-ingest import` lands it (tools/save-tables/README.md).
//
// Each table keeps its caption or nearest heading, its header row and its rows as text, with any
// player or team links' paths, so an importer can tell two players of the same name apart.
(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const label = (table) => {
    if (table.caption) return clean(table.caption.textContent);
    let el = table;
    for (let i = 0; i < 6 && el; i += 1) {
      el = el.previousElementSibling || el.parentElement;
      if (el && /^H[1-4]$/.test(el.tagName)) return clean(el.textContent);
    }
    return '';
  };
  const tables = [...document.querySelectorAll('table')]
    .map((table) => {
      const rows = [...table.querySelectorAll('tr')];
      const headerRow = table.tHead ? table.tHead.rows[table.tHead.rows.length - 1] : rows.find((r) => r.querySelector('th'));
      const headers = headerRow ? [...headerRow.cells].map((c) => clean(c.textContent)) : [];
      const body = rows
        .filter((r) => r !== headerRow && (!table.tHead || !table.tHead.contains(r)))
        .map((r) => [...r.cells].map((c) => ({ text: clean(c.textContent), href: c.querySelector('a')?.getAttribute('href') || null })))
        .filter((cells) => cells.some((c) => c.text));
      return { label: label(table), headers, rows: body };
    })
    .filter((t) => t.rows.length);
  if (!tables.length) {
    alert('Save tables: this page shows no table.');
    return;
  }
  const saved = { url: location.href, title: document.title, saved_at: new Date().toISOString(), tables };
  const name = `${location.hostname}-${location.pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'page'}-${Date.now()}.json`;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(saved)], { type: 'application/json' }));
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
})();
