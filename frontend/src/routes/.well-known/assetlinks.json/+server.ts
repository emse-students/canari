import {
  buildAssetLinksJson,
  parseAndroidSha256Fingerprints,
} from '$lib/mobile/appSiteAssociation';
import type { RequestHandler } from './$types';

/** Baked at `bun run build` so nginx can serve a static file (adapter-static). */
export const prerender = true;

/** Digital Asset Links for Android App Link verification (`canari-emse.fr`). */
export const GET: RequestHandler = () => {
  const fingerprints = parseAndroidSha256Fingerprints(import.meta.env.VITE_ANDROID_APP_LINK_SHA256);
  const body = buildAssetLinksJson(fingerprints);

  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
