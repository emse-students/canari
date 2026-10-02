/**
 * THE "BASE DE DONNEES" ADMIN PAGE (user, 2026-10-02). Pinned: a global admin sees the warning and the
 * button; anyone else is sent back to /admin; the native apps get an explanation instead of a button
 * that could never work (the session is a cookie, and the apps run on another origin); and a failure
 * is worded - by TYPE - rather than swallowed.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const admin = vi.hoisted(() => ({ value: true }));
const native = vi.hoisted(() => ({ value: false }));
const goto = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn());

vi.mock('$lib/stores/user', () => ({ isGlobalAdmin: () => admin.value }));
vi.mock('$lib/utils/tauriRuntime', () => ({ isTauriRuntime: () => native.value }));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/admin/adminerSession', async () => {
  class AdminerUnavailableError extends Error {}
  class AdminerForbiddenError extends Error {}
  return { AdminerUnavailableError, AdminerForbiddenError, openAdminer: open };
});

import Page from './+page.svelte';
import { AdminerForbiddenError, AdminerUnavailableError } from '$lib/admin/adminerSession';

const mounted: (() => void)[] = [];

beforeEach(() => {
  admin.value = true;
  native.value = false;
  goto.mockReset();
  open.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function render() {
  const app = mount(Page, { target: document.body });
  mounted.push(() => unmount(app));
  flushSync();
  await tick();
}

const button = () => document.querySelector<HTMLButtonElement>('button');
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    flushSync();
  }
};

describe('admin/database page', () => {
  it('shows a global admin the warning and the button', async () => {
    await render();
    expect(document.querySelector('[role="note"]')?.textContent).toContain('PRODUCTION');
    expect(button()?.textContent).toContain('Ouvrir Adminer');
    expect(goto).not.toHaveBeenCalled();
  });

  it('sends anyone else back to /admin', async () => {
    admin.value = false;
    await render();
    expect(goto).toHaveBeenCalledWith('/admin', { replaceState: true });
  });

  it('opens Adminer on a click', async () => {
    await render();
    button()!.click();
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('draws no button in the native apps, and says why', async () => {
    native.value = true;
    await render();
    expect(button()).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('navigateur web');
  });

  it.each([
    ['not offered here', () => new AdminerUnavailableError(), "n'est pas proposé"],
    ['not an admin', () => new AdminerForbiddenError(), 'administrateurs globaux'],
    ['anything else', () => new Error('boom'), 'Impossible'],
  ])('words a failure by its type: %s', async (_, make, words) => {
    open.mockRejectedValue(make());
    await render();
    button()!.click();
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(words);
  });

  it('does not open twice while it is opening', async () => {
    let release: () => void = () => {};
    open.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    await render();
    button()!.click();
    button()!.click();
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    release();
  });
});
