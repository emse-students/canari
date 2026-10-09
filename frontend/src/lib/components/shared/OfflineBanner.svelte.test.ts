/**
 * THE CONNECTION STRIP HAS THREE STATES (WP-OFF-5): offline, slow, and nothing. The slow one is a
 * calm hint on the existing banner surface, driven by `connectivity.slow`, and never stacks on the
 * offline one - a link that reaches nothing is not "slow".
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const session = vi.hoisted(() => ({ isLoggedIn: true, isOfflineSession: false }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({ globalSession: session }));

import OfflineBanner from './OfflineBanner.svelte';
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

  it('shows the calm slow hint, not the offline one, when answers are slow', async () => {
    const target = mountBanner();
    connectivity.trackRequest();
    await vi.advanceTimersByTimeAsync(SLOW_IN_FLIGHT_MS + 10);
    flushSync();
    expect(target.textContent).toContain(m.slow_banner_title());
    expect(target.textContent).not.toContain(m.offline_banner_title());
  });

  it('the offline banner wins when the server is unreachable', async () => {
    const target = mountBanner();
    connectivity.trackRequest();
    await vi.advanceTimersByTimeAsync(SLOW_IN_FLIGHT_MS + 10);
    connectivity.notifyServerUnreachable();
    flushSync();
    expect(target.textContent).toContain(m.offline_banner_title());
    expect(target.textContent).not.toContain(m.slow_banner_title());
  });
});
