// @vitest-environment happy-dom
/**
 * THE CONNECTION STRIP HAS THREE STATES (WP-OFF-5): offline, slow, and nothing. The slow one is a
 * small fixed icon (no strip), driven by `connectivity.slow`, and never stacks on the
 * offline one - a link that reaches nothing is not "slow".
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const session = vi.hoisted(() => ({ isLoggedIn: true, isOfflineSession: false }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({ globalSession: session }));

import OfflineBanner from './OfflineBanner.svelte';
import SlowLinkAnnouncer from './SlowLinkAnnouncer.svelte';
import { slowLink } from '$lib/stores/slowLink.svelte';
import { SLOW_IN_FLIGHT_MS, connectivity } from '$lib/stores/connectivity.svelte';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  connectivity.reset();
  session.isLoggedIn = true;
  session.isOfflineSession = false;
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function mountBanner() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(OfflineBanner, { target });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

describe('OfflineBanner', () => {
  it('shows nothing on a healthy link', () => {
    expect(mountBanner().textContent?.trim()).toBe('');
  });

  it('draws nothing itself when answers are slow: the avatar ring owns that state', async () => {
    const target = mountBanner();
    connectivity.trackRequest();
    await vi.advanceTimersByTimeAsync(SLOW_IN_FLIGHT_MS + 10);
    flushSync();
    expect(slowLink.active).toBe(true);
    expect(target.textContent?.trim()).toBe('');
    expect(target.querySelector('[data-testid="slow-link-indicator"]')).toBeNull();
  });

  it('the announcer region is always mounted and only its text switches on slow', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(SlowLinkAnnouncer, { target });
    mounted.push(() => void unmount(app));
    flushSync();
    const before = target.querySelector('[data-testid="slow-link-indicator"]');
    expect(before?.getAttribute('role')).toBe('status');
    expect(before?.textContent?.trim()).toBe('');
    connectivity.trackRequest();
    await vi.advanceTimersByTimeAsync(SLOW_IN_FLIGHT_MS + 10);
    flushSync();
    const live = target.querySelector('[data-testid="slow-link-indicator"]');
    expect(live).toBe(before);
    expect(live?.textContent?.trim()).toBe(m.slow_indicator_label());
  });

  it('the offline banner wins when the server is unreachable', async () => {
    const target = mountBanner();
    connectivity.trackRequest();
    await vi.advanceTimersByTimeAsync(SLOW_IN_FLIGHT_MS + 10);
    connectivity.notifyServerUnreachable();
    flushSync();
    expect(target.textContent).toContain(m.offline_banner_title());
    expect(target.querySelector('[data-testid="slow-link-indicator"]')).toBeNull();
  });
});
