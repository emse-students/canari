import { buildAppleAppSiteAssociationJson } from '$lib/mobile/appSiteAssociation';
import type { RequestHandler } from './$types';

/** Baked at `bun run build` so nginx can serve a static file (adapter-static). */
export const prerender = true;

/** Apple Universal Links association file for `canari-emse.fr`. */
export const GET: RequestHandler = () => {
  const body = buildAppleAppSiteAssociationJson(import.meta.env.VITE_APPLE_TEAM_ID);

  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
