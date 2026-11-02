import type { APIRoute } from 'astro';
import { entries } from '../../lib/schema-page';

/**
 * The column names of every model and seed, for the Schema overview's filter: the overview no
 * longer carries the columns, so it fetches this once, on the first search (#449).
 */
export const GET: APIRoute = () => {
  const columns = Object.fromEntries(entries.map((e) => [e.name, e.columns.map((c) => c.name)]));
  return new Response(JSON.stringify(columns), { headers: { 'content-type': 'application/json; charset=utf-8' } });
};
