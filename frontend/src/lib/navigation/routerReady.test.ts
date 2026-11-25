import { beforeEach, describe, expect, it, vi } from 'vitest';

type RouterReady = typeof import('./routerReady');

/**
 * THE ROUTER IS READY ON THE FIRST SETTLED NAVIGATION, NOT AT MOUNT (owner's Android log, 2026-11-25):
 * the real module, wired through the same call the root layout makes, with a fake `afterNavigate`.
 */
describe('routerReady', () => {
  let mod: RouterReady;
  beforeEach(async () => {
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mod = await import('./routerReady');
  });

  /** Whether the promise has resolved, read without waiting on it. */
  async function settled(p: Promise<void>): Promise<boolean> {
    let done = false;
    void p.then(() => (done = true));
    await new Promise((r) => setTimeout(r, 0));
    return done;
  }

  it('stays pending until the first afterNavigate, then resolves', async () => {
    let fire: () => void = () => {};
    mod.readyOnFirstNavigation((callback) => {
      fire = callback;
    });
    expect(await settled(mod.routerReady)).toBe(false);
    fire();
    expect(await settled(mod.routerReady)).toBe(true);
  });

  it('says it once, however many navigations follow', async () => {
    let fire: () => void = () => {};
    mod.readyOnFirstNavigation((callback) => {
      fire = callback;
    });
    fire();
    fire();
    expect(
      vi.mocked(console.log).mock.calls.filter((c) => String(c[0]).includes('[router] ready'))
    ).toHaveLength(1);
  });
});
