// @vitest-environment happy-dom
import { flushSync } from 'svelte';
import { APP_FOREGROUND_EVENT } from '$lib/utils/appForeground';

/**
 * A RESUME FROM A PAGE NOTIFICATION WAITS FOR ITS LANDING ONLY WHILE A TAP LISTENER IS REGISTERED
 * (review of #2937, items 4 and 5). The signal is positive: `armPageTapListener` arms the hold only
 * when the plugin's `onAction` registration RESOLVED. Every test loads FRESH modules, as a WebView
 * load does, so each passes alone and none leaks the session-wide flag into another.
 */

type Modules = {
  hold: typeof import('./resumeOpening.svelte');
  tap: typeof import('./pageNotificationTap');
  nav: typeof import('$lib/stores/notifNav.svelte');
};

async function load(): Promise<Modules> {
  vi.resetModules();
  return {
    hold: await import('./resumeOpening.svelte'),
    tap: await import('./pageNotificationTap'),
    nav: await import('$lib/stores/notifNav.svelte'),
  };
}

function announce(foreground: boolean) {
  (window as unknown as Record<string, unknown>).__canariForeground = foreground;
  window.dispatchEvent(
    new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground, opening: null } })
  );
  flushSync();
}

const resolve = (id: string) => `dm:${id}`;

/** A resume from a page notification with X on screen; whether X is then held. */
function resumeFromPageTap(m: Modules): boolean {
  announce(true);
  announce(false);
  m.hold.noteResumeOpening(m.hold.PAGE_NOTIFICATION_OPENING, 'dm:x', resolve);
  return m.hold.resumeOpeningHolds('dm:x');
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  delete (window as unknown as Record<string, unknown>).__canariForeground;
});

it('a RESOLVED registration arms the hold: X is held until the landing names Y', async () => {
  const m = await load();
  m.tap.armPageTapListener(
    async () => undefined,
    () => {}
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(resumeFromPageTap(m)).toBe(true);
  m.nav.notifNav.navigate('y');
  flushSync();
  expect(m.hold.resumeOpeningHolds('dm:x')).toBe(true);
  m.nav.notifNav.clear();
  flushSync();
  expect(m.hold.resumeOpeningHolds('dm:x')).toBe(false);
});

it('a page that never registered (a reload since the notification was posted) holds nothing', async () => {
  const m = await load();
  expect(resumeFromPageTap(m)).toBe(false);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('page notification tap lost'));
});

it('a plugin without onAction holds nothing, and says so at registration', async () => {
  const m = await load();
  m.tap.armPageTapListener(undefined, () => {});
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('exposes no onAction'));
  expect(resumeFromPageTap(m)).toBe(false);
});

it('a registration that THROWS holds nothing, and says so', async () => {
  const m = await load();
  m.tap.armPageTapListener(
    () => {
      throw new Error('shape refused');
    },
    () => {}
  );
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be registered'));
  expect(resumeFromPageTap(m)).toBe(false);
});

it('a registration that REJECTS holds nothing, and says so', async () => {
  const m = await load();
  m.tap.armPageTapListener(
    () => Promise.reject(new Error('refused')),
    () => {}
  );
  await vi.waitFor(() =>
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be registered'))
  );
  expect(resumeFromPageTap(m)).toBe(false);
});

it('the registration hands the plugin the tap handler it was given', async () => {
  const m = await load();
  const onTap = vi.fn();
  let given: ((a: { notification?: { id?: number } | null }) => void) | undefined;
  m.tap.armPageTapListener(async (cb) => {
    given = cb;
  }, onTap);
  given?.({ notification: { id: 7 } });
  expect(onTap).toHaveBeenCalledWith({ notification: { id: 7 } });
});
