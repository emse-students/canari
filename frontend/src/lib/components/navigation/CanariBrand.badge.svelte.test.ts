// @vitest-environment happy-dom
/**
 * THE TEST-ENVIRONMENT MARK IS A BADGE ON THE LOGO (owner, 2026-11-11): present on a non-production
 * build, absent in production. It is not on the avatar, whose ring is the connection indicator.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const state = vi.hoisted(() => ({ nonProduction: true }));
vi.mock('$lib/utils/deployEnvironment', () => ({
  isNonProductionDeployment: () => state.nonProduction,
}));

import CanariBrand from './CanariBrand.svelte';

let component: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

function render() {
  const host = document.createElement('div');
  document.body.append(host);
  component = mount(CanariBrand, { target: host, props: { subtitle: '' } });
  flushSync();
  return host;
}

describe('CanariBrand environment badge', () => {
  it('shows on a non-production build, labelled, with a tooltip and no dismiss control', () => {
    state.nonProduction = true;
    const host = render();
    const badge = host.querySelector('[data-testid="environment-badge"]');
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute('aria-label')).toBeTruthy();
    expect(badge!.getAttribute('title')).toBe(badge!.getAttribute('aria-label'));
    expect(host.querySelector('button')).toBeNull();
  });

  it('is absent in production', () => {
    state.nonProduction = false;
    expect(render().querySelector('[data-testid="environment-badge"]')).toBeNull();
  });
});
