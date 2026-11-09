/**
 * A DESTINATION BUILT BY CODE IS A PAGE OF THIS BUILD - a notification's, a deep link's.
 *
 * SvelteKit 3's `goto` rejects a path no route matches, and these destinations go to `goto`
 * directly (the bell, `/notifications`, the push tap in `hooks.client.ts`). The compiler is the
 * first guard: each producer returns `AppPath`, a template the route table types, so a route
 * renamed under it fails `bun run check` - the `@ts-expect-error` below fails that check the day
 * `AppPath` stops refusing a path with no page. A template accepts any text in a `${string}`
 * segment, including a `/`, so this walks every producer through the app's real route table
 * (`src/test/mocks/app-paths.ts` reads `src/routes`) as well.
 */
import { describe, expect, it } from 'vitest';
import { match } from '$app/paths';
import type { AppPath } from '$lib/utils/internalPath';
import {
  KNOWN_NOTIFICATION_TYPES,
  notificationHref,
  resolveNotificationHref,
} from '$lib/posts/notificationTarget';
import { appRouteForDeepLink } from '$lib/mobile/deepLinkRoutes';
import { shopReturnPath } from '$lib/shop/checkoutReturn';

/** The deep-link hosts `appRouteForDeepLink` owns, each with the id the server writes. */
const DEEP_LINKS = [
  'fr.emse.canari://post/p-1',
  'fr.emse.canari://post/p-1?comment=c-1',
  'fr.emse.canari://form/f-1',
  'fr.emse.canari://form-responses/f-1',
  'fr.emse.canari://posts',
  'fr.emse.canari://calendar',
  'fr.emse.canari://admin-agenda',
  'fr.emse.canari://live/l-1',
  'fr.emse.canari://republication-requests',
  'fr.emse.canari://follow-requests',
  'fr.emse.canari://notifications',
];

describe('a destination built by code', () => {
  it('is typed against the route table, which refuses a path with no page', () => {
    const page: AppPath = '/posts/p-1';
    // @ts-expect-error - no route of this app is called that; `bun run check` fails if it types.
    const none: AppPath = '/no-such-page';
    expect([page, none]).toHaveLength(2);
  });

  it('for every notification type with a destination, is a page of this build', async () => {
    const missing: string[] = [];
    for (const type of KNOWN_NOTIFICATION_TYPES) {
      const href = await resolveNotificationHref({ type, postId: 'id-1' }, async () => 'asso');
      if (href && !(await match(href))) missing.push(`${type} -> ${href}`);
    }
    expect(missing).toEqual([]);
    // The walk saw destinations at all (a table returning null everywhere would pass vacuously).
    expect(notificationHref({ type: 'comment', postId: 'p' })).toBe('/posts/p');
  });

  it('for every deep-link host the table owns, is a page of this build', async () => {
    const missing: string[] = [];
    for (const link of DEEP_LINKS) {
      const route = appRouteForDeepLink(new URL(link));
      if (!route || !(await match(route))) missing.push(`${link} -> ${route}`);
    }
    expect(missing).toEqual([]);
  });

  it('for a checkout return to the shop, is a page of this build', async () => {
    const path = shopReturnPath('purchase_success', new URLSearchParams({ productId: 'x' }));
    expect(await match(path)).not.toBeNull();
  });
});
