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

Sitemap: ${origin}/sitemap.xml
`;

  return new Response(body.trim() + '\n', {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
};
