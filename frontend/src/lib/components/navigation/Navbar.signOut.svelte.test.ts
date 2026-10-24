// @vitest-environment happy-dom
/**
 * A SIGN-OUT CAN WAIT UP TO THE LOGOUT DEADLINE FOR THE SERVER'S REVOCATION (30 s), so the button
 * says it is busy and a second tap is ignored - it would otherwise send a second logout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

let finishClear: () => void = () => {};
const clearAuth = vi.fn(
  () =>
    new Promise<void>((resolve) => {
      finishClear = resolve;
    })
);
const leaveSignedOut = vi.fn(async () => {});

vi.mock('$lib/stores/auth', () => ({
  signOutByChoice: async () => {
    await clearAuth();
    await leaveSignedOut();
  },
}));

const { default: Navbar } = await import('./Navbar.svelte');

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  clearAuth.mockClear();
  leaveSignedOut.mockClear();
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host.remove();
});

function logoutButton(): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((b) => b.hasAttribute('aria-busy'));
  if (!button) throw new Error('logout button not rendered');
  return button;
}

describe('the navbar sign-out', () => {
  it('is busy while the sign-out runs, ignores a second tap, and frees itself when done', async () => {
    component = mount(Navbar, { target: host });
    flushSync();

    logoutButton().click();
    flushSync();
    expect(logoutButton().disabled).toBe(true);
    expect(logoutButton().getAttribute('aria-busy')).toBe('true');

    // A second tap starts no second sign-out.
    logoutButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    expect(clearAuth).toHaveBeenCalledTimes(1);

    finishClear();
    await tick();
    await Promise.resolve();
    await tick();
    flushSync();
    expect(leaveSignedOut).toHaveBeenCalledTimes(1);
    expect(logoutButton().disabled).toBe(false);
  });
});
