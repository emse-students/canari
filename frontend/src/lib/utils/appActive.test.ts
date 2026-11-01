// @vitest-environment happy-dom
/**
 * THE PAGE ASKS THE NATIVE ACTIVE STATE (`appActive.ts`), so a transition whose push was lost
 * (`evaluateJavaScript` failed) cannot leave the page withholding every queued frame in front.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$lib/utils/appVersion', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isIosTauriRuntime: () => true,
}));

const { syncIosActiveFromNative, installIosActiveQuery, isIosAppInactive, APP_ACTIVE_EVENT } =
  await import('$lib/utils/appActive');

const flag = () => (window as unknown as Record<string, unknown>).__canariActive;

/** What iOS tells the page (`CanariPushActiveToPage`). */
function told(value: boolean) {
  (window as unknown as Record<string, unknown>).__canariActive = value;
  window.dispatchEvent(new CustomEvent(APP_ACTIVE_EVENT, { detail: { active: value } }));
}

describe('the page asks whether the iPhone app is active', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  let events: boolean[];
  const onEvent = (e: Event) => events.push((e as CustomEvent<{ active: boolean }>).detail.active);

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    events = [];
    window.addEventListener(APP_ACTIVE_EVENT, onEvent);
  });

  afterEach(() => {
    window.removeEventListener(APP_ACTIVE_EVENT, onEvent);
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>).__canariActive;
  });

  it('a lost "active" push is corrected by the answer, the event fired, and the loss accused', async () => {
    told(false);
    events = [];
    await syncIosActiveFromNative('visibilitychange', async () => true);
    expect(flag()).toBe(true);
    expect(isIosAppInactive()).toBe(false);
    expect(events).toEqual([true]);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('an answer that agrees changes nothing and says nothing', async () => {
    told(true);
    events = [];
    await syncIosActiveFromNative('visibilitychange', async () => true);
    expect(events).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });

  it('an answer overtaken by a told transition is dropped - the push is newer', async () => {
    const uninstall = installIosActiveQuery(async () => null);
    told(true);
    let answer!: (v: boolean) => void;
    const asked = syncIosActiveFromNative(
      'visibilitychange',
      () => new Promise<boolean>((r) => (answer = r))
    );
    told(false);
    answer(true);
    await asked;
    expect(flag()).toBe(false);
    uninstall();
  });

  it('no answer is an error and leaves the page value alone', async () => {
    told(false);
    await syncIosActiveFromNative('page load', async () => null);
    expect(flag()).toBe(false);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('asks on install, on every visibilitychange, and on every window focus (an inactive-only return changes no visibility)', async () => {
    const ask = vi.fn(async () => true);
    const uninstall = installIosActiveQuery(ask);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    expect(ask).toHaveBeenCalledTimes(3);
    uninstall();
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('a lost YES after Control Center is recovered on focus, with no visibility change', async () => {
    let uikit = false;
    const uninstall = installIosActiveQuery(async () => uikit);
    await new Promise((r) => setTimeout(r, 0));
    told(false); // Control Center pulled down: told.
    uikit = true; // Pushed away again: UIKit is active, but the told YES is lost.
    expect(isIosAppInactive()).toBe(true);
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 0));
    expect(flag()).toBe(true);
    expect(isIosAppInactive()).toBe(false);
    uninstall();
  });
});
