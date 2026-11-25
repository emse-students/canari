// @vitest-environment happy-dom
/**
 * A META IN-APP BROWSER RUNS NOTHING OF THE APP (owner decision of 2026-11-25): the root load
 * returns before the silent refresh and before any redirect to login, and the root layout keeps
 * every effect that starts something off while the guard holds.
 * docs/wiki/frontend/leaving-in-app-browsers.md.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const guard = vi.hoisted(() => ({ value: null as unknown }));
const goto = vi.hoisted(() => vi.fn(async () => {}));
const boot = vi.hoisted(() => ({ start: vi.fn(), settle: vi.fn() }));
const refresh = vi.hoisted(() => vi.fn());

vi.mock('$lib/mobile/inAppBrowserGuard', () => ({ inAppBrowserGuard: () => guard.value }));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => null }));
vi.mock('$lib/stores/auth', () => ({ refresh }));
vi.mock('$lib/utils/sessionProfileCheck', () => ({ checkSessionUserInBackground: vi.fn() }));
vi.mock('$lib/stores/bootSession.svelte', () => ({
  startBootSession: boot.start,
  settleBootSession: boot.settle,
}));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => p }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: { isLoggedIn: false, isLoginInProgress: false },
}));

import { load } from './+layout';

beforeEach(() => {
  vi.clearAllMocks();
  guard.value = null;
});

describe('the root load under a Meta in-app browser', () => {
  it('starts no session, no refresh and no redirect', async () => {
    guard.value = { browser: { app: 'messenger', os: 'ios', iosMajor: 18 }, href: 'x' };
    await load({ url: new URL('http://x.test/posts/abc'), fetch } as never);
    expect(boot.start).not.toHaveBeenCalled();
    expect(boot.settle).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(goto).not.toHaveBeenCalled();
  });

  it('starts the boot session as before in any other browser', async () => {
    await load({ url: new URL('http://x.test/posts/abc'), fetch } as never);
    expect(boot.start).toHaveBeenCalledTimes(1);
  });
});

describe('the root layout under a Meta in-app browser', () => {
  // Read as text: mounting the root layout would mount the whole app. Each starter is reached only
  // through a condition that is false while the guard holds.
  const layout = readFileSync(resolve(import.meta.dirname, '+layout.svelte'), 'utf8');

  it('draws the way out in place of the app', () => {
    expect(layout).toMatch(/\{#if inAppBrowser\}\s*<LeaveInAppBrowser guard=\{inAppBrowser\} \/>/);
  });

  it('keeps the account starters off: publish queue, birthdays, draft resend', () => {
    const gated =
      'const userId = !inAppBrowser && globalSession.isLoggedIn ? globalSession.userId : null;';
    expect(layout.split(gated).length - 1).toBe(3);
    expect(layout).not.toContain('const userId = globalSession.isLoggedIn ?');
  });

  it('keeps push, the admin counts, the DND ask, the route preload and onMount off', () => {
    expect(layout).toMatch(
      /!inAppBrowser &&\s*globalSession\.isLoggedIn &&\s*globalSession\.userId/
    );
    expect(layout).toMatch(/const adminCountsAccount = \$derived\(\s*!inAppBrowser &&/);
    expect(layout).toContain('if (inAppBrowser || dndAskDone');
    expect(layout).toContain('if (inAppBrowser || !swipeNavArmed) return;');
    expect(layout).toContain('if (inAppBrowser) return;');
  });
});
