import type { APIRoute, GetStaticPaths } from 'astro';
import { diagramIds, schemaDiagrams } from '../../../lib/schema-diagrams';

/**
 * The Schema page's diagrams as files: the page holds a place for each and loads it as it nears
 * the viewport, so the page itself stays small (#449).
 */
export const getStaticPaths = (() => diagramIds().map((id) => ({ params: { id } }))) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ params }) => {
  const svg = (await schemaDiagrams()).get(params.id ?? '');
  if (!svg) return new Response('not found', { status: 404 });
  return new Response(svg, { headers: { 'content-type': 'image/svg+xml; charset=utf-8' } });
};
