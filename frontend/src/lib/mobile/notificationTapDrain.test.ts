// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NATIVE_NOTIFICATION_TAP_EVENT,
  listenForNativeNotificationTaps,
  parseNativeNotificationTap,
  takeNativeNotificationTap,
} from './notificationTapDrain';

const LINK = 'fr.emse.canari://chat/3f2b8c1e-9a4d-4e7f-b6c2-0d1e2f3a4b5c';
const record = (deepLink: unknown) => JSON.stringify({ deepLink, tappedAt: 1 });

/** Waits for the promise chain a drain starts (take -> then -> open). */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('parseNativeNotificationTap', () => {
  it('returns the link of a record the native side writes', () => {
    expect(parseNativeNotificationTap(record(LINK))).toBe(LINK);
  });

  it('drops what is not a record of this app, and says so', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseNativeNotificationTap('not json')).toBeNull();
    expect(parseNativeNotificationTap(record(''))).toBeNull();
    expect(parseNativeNotificationTap(record(42))).toBeNull();
    expect(parseNativeNotificationTap('null')).toBeNull();
    expect(parseNativeNotificationTap(record('https://evil.example/chat/x'))).toBeNull();
    expect(parseNativeNotificationTap(record('fr.emse.canarix://chat/x'))).toBeNull();
    expect(error).toHaveBeenCalledTimes(6);
    error.mockRestore();
  });
});

describe('takeNativeNotificationTap', () => {
  it('answers null when nothing waits', async () => {
    expect(await takeNativeNotificationTap(async () => null)).toBeNull();
  });

  it('answers null, said, when the command fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await takeNativeNotificationTap(async () => {
        throw new Error('ipc down');
      })
    ).toBeNull();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});

describe('listenForNativeNotificationTaps', () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
  });

  it('takes a tap that came before the page (a cold start) once, at registration', async () => {
    let waiting: string | null = record(LINK);
    const take = vi.fn(async () => {
      const r = waiting;
      waiting = null;
      return r;
    });
    const open = vi.fn();
    stop = listenForNativeNotificationTaps(open, take);
    await settle();
    expect(open).toHaveBeenCalledExactlyOnceWith(LINK);
    expect(take).toHaveBeenCalledOnce();
  });

  it('registers the listener BEFORE its first take, so an event in between is never lost', () => {
    const order: string[] = [];
    const add = vi.spyOn(window, 'addEventListener').mockImplementation((type) => {
      if (type === NATIVE_NOTIFICATION_TAP_EVENT) order.push('listen');
    });
    stop = listenForNativeNotificationTaps(
      () => {},
      async () => {
        order.push('take');
        return null;
      }
    );
    add.mockRestore();
    expect(order).toEqual(['listen', 'take']);
  });

  it('takes again when the native side says a tap waits, and opens each tap once', async () => {
    let waiting: string | null = null;
    const take = vi.fn(async () => {
      const r = waiting;
      waiting = null;
      return r;
    });
    const open = vi.fn();
    stop = listenForNativeNotificationTaps(open, take);
    await settle();
    expect(open).not.toHaveBeenCalled();

    waiting = record(LINK);
    window.dispatchEvent(new CustomEvent(NATIVE_NOTIFICATION_TAP_EVENT));
    // A repeated event reads an empty file.
    window.dispatchEvent(new CustomEvent(NATIVE_NOTIFICATION_TAP_EVENT));
    await settle();
    expect(open).toHaveBeenCalledExactlyOnceWith(LINK);
    expect(take).toHaveBeenCalledTimes(3);
  });

  it('stops listening once unsubscribed', async () => {
    const take = vi.fn(async () => null);
    listenForNativeNotificationTaps(() => {}, take)();
    window.dispatchEvent(new CustomEvent(NATIVE_NOTIFICATION_TAP_EVENT));
    await settle();
    expect(take).toHaveBeenCalledOnce();
  });
});
