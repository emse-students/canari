import { siteOrigin } from '$lib/seo/site';
import type { RequestHandler } from './$types';

/** Prerendered for static hosting (nginx serves `/robots.txt`). */
export const prerender = true;

/** Crawler rules for the public Canari web app. */
export const GET: RequestHandler = () => {
  const origin = siteOrigin();
  const body = `# Canari - https://canari-emse.fr
User-agent: *
Allow: /posts
Allow: /associations
Allow: /forms/
Allow: /legal/
Disallow: /api/
Disallow: /chat
Disallow: /communities
Disallow: /admin/
Disallow: /dev/
Disallow: /auth/
Disallow: /dashboard
Disallow: /profile/
Disallow: /notifications
Disallow: /account/
Disallow: /login
# One-time invite tokens. They now unfurl with the real community/group name, which is
# what a shared link is for - but an unfurl is a preview to whoever holds the link, and an
# index entry is a public listing of it.
Disallow: /c/join/
Disallow: /g/join/

Sitemap: ${origin}/sitemap.xml
`;

  return new Response(body.trim() + '\n', {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
};
