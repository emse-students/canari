/**
 * THE TEST-ENVIRONMENT BANNER CLOSES FOR THE SESSION, AND ONLY THE SESSION (user, 2026-09-30).
 * It was permanent because dev holds a copy of production; it became closable because on a phone it
 * cost ~180 px of every screen. What these pin is the half that keeps the old reason alive: the
 * dismissal is in `sessionStorage`, so a new launch shows the banner again.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/utils/deployEnvironment', () => ({ isNonProductionDeployment: () => true }));

import EnvironmentBanner from './EnvironmentBanner.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  sessionStorage.clear();
});

function mountBanner() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(EnvironmentBanner, { target });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

describe('EnvironmentBanner', () => {
  it('shows on a non-production build, with a close button', () => {
    const target = mountBanner();
    expect(target.querySelector('[role="status"]')).not.toBeNull();
    expect(target.querySelector('button')).not.toBeNull();
  });

  it('closes on the X and remembers it for the session', () => {
    const target = mountBanner();
    target.querySelector('button')!.click();
    flushSync();
    expect(target.querySelector('[role="status"]')).toBeNull();
    expect(sessionStorage.getItem('canari_env_banner_dismissed')).toBe('1');
  });

  it('stays closed on a remount within the session', () => {
    sessionStorage.setItem('canari_env_banner_dismissed', '1');
    expect(mountBanner().querySelector('[role="status"]')).toBeNull();
  });

  it('comes back once the session is gone', () => {
    sessionStorage.setItem('canari_env_banner_dismissed', '1');
    sessionStorage.clear();
    expect(mountBanner().querySelector('[role="status"]')).not.toBeNull();
  });
});
