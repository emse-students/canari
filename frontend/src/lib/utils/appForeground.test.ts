// @vitest-environment happy-dom
/**
 * The one fact a native mobile WebView cannot work out for itself.
 *
 * Measured on device 2026-09-05 (Mi 9T, Android 16): a BACKGROUNDED Tauri app reports
 * `{visibilityState: "visible", hidden: false, hasFocus: true}` - byte for byte its foreground
 * answer - while its JS keeps running. `WryActivity.onPause` already calls `mWebView.onPause()`, so
 * it is not a missing lifecycle call: `WebView.onPause()` does not drive the Page Visibility API.
 *
 * Two things depended on the document's answer and were therefore wrong on every phone: a
 * backgrounded device raised no notification for a message no push would ever carry, and it sent a
 * READ RECEIPT for a message nobody had seen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_ACTIVE_EVENT,
  APP_FOREGROUND_EVENT,
  isAppActive,
  isAppInForeground,
  isAppInFront,
  isAppInView,
  onAppActiveChange,
  onAppForegroundChange,
  onAppViewChange,
  watchViewLoss,
} from './appForeground';

const FLAG = '__canariForeground';
const set = (v: unknown) => {
  (window as unknown as Record<string, unknown>)[FLAG] = v;
};
const clear = () => {
  delete (window as unknown as Record<string, unknown>)[FLAG];
};

afterEach(() => {
  clear();
  delete (window as unknown as Record<string, unknown>).__canariActive;
});

describe('isAppInForeground', () => {
  it('reads the flag the Android activity writes', () => {
    set(false);
    expect(isAppInForeground()).toBe(false);
    set(true);
    expect(isAppInForeground()).toBe(true);
  });

  it('IS NOT CACHED - a page that loaded while backgrounded gets the current value, not the first', () => {
    set(false);
    expect(isAppInForeground()).toBe(false);
    // The activity resumes; nothing re-imported and no listener was ever registered.
    set(true);
    expect(isAppInForeground()).toBe(true);
  });

  it('says "on screen" where nothing states the fact - which is every other runtime', () => {
    clear();
    expect(isAppInForeground()).toBe(true);
  });

  it('and where something states it BADLY, which is not the same as stating false', () => {
    // A string, a number, a null: none of them is the activity's boolean. Treating any of them as
    // falsy would turn a malformed bridge into "the app is backgrounded" and notify over the user's
    // shoulder, so only a real boolean is believed.
    for (const junk of ['false', 0, null, undefined, {}]) {
      set(junk);
      expect(isAppInForeground()).toBe(true);
    }
  });
});

describe('onAppForegroundChange', () => {
  it('fires on the activity event, both ways, and unsubscribes', () => {
    const seen: boolean[] = [];
    const off = onAppForegroundChange((f) => seen.push(f));

    window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: false } }));
    window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: true } }));
    expect(seen).toEqual([false, true]);

    off();
    window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: false } }));
    expect(seen).toEqual([false, true]);
  });

  it('ignores an event carrying no boolean rather than inventing one', () => {
    const onChange = vi.fn();
    const off = onAppForegroundChange(onChange);

    window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: {} }));
    window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: 'no' } }));
    window.dispatchEvent(new Event(APP_FOREGROUND_EVENT));

    expect(onChange).not.toHaveBeenCalled();
    off();
  });
});

describe('onAppScreenChange - one edge per transition', () => {
  it('reports a trip to the background ONCE when both signals announce it (iOS)', async () => {
    const { onAppScreenChange } = await import('./appForeground');
    set(true);
    const edges: boolean[] = [];
    const off = onAppScreenChange((onScreen) => edges.push(onScreen));
    const hidden = vi.spyOn(document, 'visibilityState', 'get');
    try {
      // The shell's event first, then the WebView's own visibilitychange: one transition.
      set(false);
      window.dispatchEvent(
        new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: false } })
      );
      hidden.mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      // And back, in the opposite order.
      hidden.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      set(true);
      window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: true } }));
      expect(edges).toEqual([false, true]);
    } finally {
      off();
      hidden.mockRestore();
    }
  });
});

describe('the ACTIVE fact (iOS willResignActive / didBecomeActive)', () => {
  const setActive = (v: unknown) => {
    (window as unknown as Record<string, unknown>).__canariActive = v;
  };

  it('is true where no shell writes it, and believes only a boolean', () => {
    expect(isAppActive()).toBe(true);
    for (const junk of ['false', 0, null, {}]) {
      setActive(junk);
      expect(isAppActive()).toBe(true);
    }
    setActive(false);
    expect(isAppActive()).toBe(false);
  });

  it('puts the app in front of the reader only when it is BOTH in the foreground and active', () => {
    set(true);
    setActive(true);
    expect(isAppInFront()).toBe(true);
    // The home gesture: inactive, the background edge not there yet - the window of the defect.
    setActive(false);
    expect(isAppInForeground()).toBe(true);
    expect(isAppInFront()).toBe(false);
    set(false);
    setActive(true);
    expect(isAppInFront()).toBe(false);
  });

  it('reports each edge of its event, and unsubscribes', () => {
    const seen: boolean[] = [];
    const off = onAppActiveChange((active) => seen.push(active));
    window.dispatchEvent(new CustomEvent(APP_ACTIVE_EVENT, { detail: { active: false } }));
    window.dispatchEvent(new CustomEvent(APP_ACTIVE_EVENT, { detail: { active: 'no' } }));
    window.dispatchEvent(new CustomEvent(APP_ACTIVE_EVENT, { detail: { active: true } }));
    off();
    window.dispatchEvent(new CustomEvent(APP_ACTIVE_EVENT, { detail: { active: false } }));
    expect(seen).toEqual([false, true]);
  });
});

describe('the VIEW: foreground, active and the page visible (an encoder the system stops)', () => {
  const active = (value: boolean) => {
    (window as unknown as Record<string, unknown>).__canariActive = value;
    window.dispatchEvent(new CustomEvent(APP_ACTIVE_EVENT, { detail: { active: value } }));
  };
  const foreground = (value: boolean) => {
    set(value);
    window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: value } }));
  };

  it('is out of view when any one of the three says so', () => {
    expect(isAppInView()).toBe(true);
    active(false);
    expect(isAppInView()).toBe(false);
    active(true);
    foreground(false);
    expect(isAppInView()).toBe(false);
  });

  it('reports one edge per change of the combined answer', () => {
    const edges: boolean[] = [];
    const off = onAppViewChange((inView) => edges.push(inView));
    active(false);
    foreground(false);
    foreground(true);
    active(true);
    off();
    active(false);
    expect(edges).toEqual([false, true]);
  });

  it('latches a loss the app has already come back from', () => {
    const watch = watchViewLoss();
    expect(watch.lost).toBe(false);
    active(false);
    active(true);
    expect(watch.lost).toBe(true);
    watch.stop();
  });

  it('is lost from the start when the app is already out of view', () => {
    foreground(false);
    const watch = watchViewLoss();
    foreground(true);
    expect(watch.lost).toBe(true);
    watch.stop();
  });

  it('stays clear when nothing left the view', () => {
    const watch = watchViewLoss();
    watch.stop();
    active(false);
    expect(watch.lost).toBe(false);
  });
});
