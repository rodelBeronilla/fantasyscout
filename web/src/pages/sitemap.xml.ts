import type { APIRoute } from 'astro';

/**
 * The static pages, one URL each, built from the pages folder so a new page joins without a list to
 * update. The player pages have their own sitemap, served by the Worker from the current build
 * (/sitemap-players.xml); the SQL console and the data route are not for crawlers (robots.txt).
 */
const SITE = 'https://fantasyscout.beronilla.rodeo';
const pages = import.meta.glob('./**/*.astro', { eager: false });

export const GET: APIRoute = () => {
  const routes = Object.keys(pages)
    .map((file) => file.replace(/^\.\//, '').replace(/(^|\/)index\.astro$/, '/').replace(/\.astro$/, '/'))
    .map((route) => (route.startsWith('/') ? route : `/${route}`))
    .filter((route) => !['/404/', '/sql/', '/p/'].includes(route))
    .sort();
  const urls = routes.map((r) => `  <url><loc>${SITE}${r}</loc><changefreq>daily</changefreq></url>`).join('\n');
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
};
