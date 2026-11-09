import type { APIRoute } from 'astro';
import { entries } from '../lib/schema-page';
import { SHOWS } from '../lib/visibility';

/**
 * The static pages, one URL each, built from the pages folder so a new page joins without a list to
 * update. The player pages have their own sitemap, served by the Worker from the current build
 * (/sitemap-players.xml); the SQL console and the data route are not for crawlers (robots.txt). A page
 * built from a route parameter is listed by its own URLs: the Schema has one per model and seed (#449).
 */
const SITE = 'https://fantasyscout.beronilla.rodeo';
const pages = import.meta.glob('./**/*.astro', { eager: false });

export const GET: APIRoute = () => {
  const routes = Object.keys(pages)
    .map((file) => file.replace(/^\.\//, '').replace(/(^|\/)index\.astro$/, '/').replace(/\.astro$/, '/'))
    .map((route) => (route.startsWith('/') ? route : `/${route}`))
    .filter((route) => !['/404/', '/sql/', '/p/'].includes(route) && !route.includes('['))
    // a page that is off for now only sends its visitor to Rankings (#936)
    .filter((route) => (route !== '/draft/' || SHOWS.draft) && (route !== '/notes/' || SHOWS.notes))
    .concat(entries.map((e) => `/schema/${e.name}/`))
    .sort();
  const urls = routes.map((r) => `  <url><loc>${SITE}${r}</loc><changefreq>daily</changefreq></url>`).join('\n');
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
};
