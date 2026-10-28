/**
 * A PAGE WHOSE URL CARRIES A CAPABILITY SENDS NO PATH IN ITS REFERER, WHEREVER IT IS SERVED
 * (2026-10-28).
 *
 * On the web the policy is a response HEADER (`$capability_referrer_policy` in
 * `infrastructure/local/Dockerfile.frontend`, asserted by `static-headers.test.mjs`), because a page
 * that boots on the client sends its first chunk requests before any <meta> applies. The Tauri app
 * has no nginx, a dev server sends no such header, and a client-side navigation onto one of these
 * pages receives no response header at all - so each page also carries the <meta>. The receipt
 * page's own rendered test checks its <meta> in the DOM; this one pins the same line in the others,
 * read from their source because each needs a session, a router and a service to render. The login
 * page is one of them: a join page sends a signed-out reader there with the invite in `returnTo`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const routes = dirname(fileURLToPath(import.meta.url));

// strict-origin for the 2026-10-28 pages: the policy outlives the page in a document that never
// reloads, and no-referrer would make every later same-origin POST carry `Origin: null`. The receipt
// page keeps the no-referrer it shipped with.
describe('capability pages send no path in their Referer', () => {
  for (const [page, policy] of [
    ['c/join/[token]/+page.svelte', 'strict-origin'],
    ['g/join/[token]/+page.svelte', 'strict-origin'],
    ['auth/callback/+page.svelte', 'strict-origin'],
    ['login/+page.svelte', 'strict-origin'],
    ['f/[id]/receipt/+page.svelte', 'no-referrer'],
  ]) {
    it(`${page} declares ${policy} in its head, and only that`, () => {
      const source = readFileSync(join(routes, page), 'utf8');
      const head = source.match(/<svelte:head>([\s\S]*?)<\/svelte:head>/)?.[1] ?? '';
      const policies = [...head.matchAll(/<meta name="referrer" content="([^"]*)" \/>/g)].map(
        (m) => m[1]
      );
      expect(policies).toEqual([policy]);
    });
  }
});
