import { describe, expect, it } from 'vitest';

import { createDeepLinkClaims } from './deepLinkClaims';

/** A `Storage` good enough for these tests, with a switch to make every access throw. */
function fakeStorage(): Storage & { denied: boolean; raw: Map<string, string> } {
  const raw = new Map<string, string>();
  const guard = <T>(fn: () => T): T => {
    if (store.denied) throw new DOMException('denied', 'SecurityError');
    return fn();
  };
  const store = {
    denied: false,
    raw,
    getItem: (k: string) => guard(() => raw.get(k) ?? null),
    setItem: (k: string, v: string) => guard(() => void raw.set(k, v)),
    removeItem: (k: string) => guard(() => void raw.delete(k)),
    clear: () => guard(() => raw.clear()),
    key: (i: number) => [...raw.keys()][i] ?? null,
    get length() {
      return raw.size;
    },
  } as Storage & { denied: boolean; raw: Map<string, string> };
  return store;
}

const URL_A = 'fr.emse.canari://chat/642f389a-2800-412d-ab7c-cc521587f97f';
const URL_B = 'fr.emse.canari://chat/00000000-0000-0000-0000-000000000000';

describe('deepLinkClaims', () => {
  it('claims a URL once and refuses every repeat', () => {
    const claims = createDeepLinkClaims(fakeStorage());
    expect(claims.claim(URL_A)).toBe(true);
    expect(claims.claim(URL_A)).toBe(false);
    expect(claims.claim(URL_A)).toBe(false);
  });

  it('lets a DIFFERENT URL through - a second notification is not a replay', () => {
    const claims = createDeepLinkClaims(fakeStorage());
    expect(claims.claim(URL_A)).toBe(true);
    expect(claims.claim(URL_B)).toBe(true);
    expect(claims.claim(URL_B)).toBe(false);
  });

  // THE REGRESSION. A WebView reload wipes every module variable but keeps `sessionStorage`, while
  // the Rust plugin keeps answering `getCurrent()` with the original launch URL. An in-memory guard
  // therefore let the reload re-publish `notifNav` and teleport the user into the conversation that
  // had launched the app - measured on hardware 15 minutes after the launch, 2026-08-07.
  it('survives a reload: a new instance over the same storage does not re-claim', () => {
    const storage = fakeStorage();
    expect(createDeepLinkClaims(storage).claim(URL_A)).toBe(true);
    // A reload = fresh module state, same session storage.
    expect(createDeepLinkClaims(storage).claim(URL_A)).toBe(false);
  });

  it('does NOT survive a new session: a cold start still processes its launch URL', () => {
    expect(createDeepLinkClaims(fakeStorage()).claim(URL_A)).toBe(true);
    // A new process = a new WebView = empty storage.
    expect(createDeepLinkClaims(fakeStorage()).claim(URL_A)).toBe(true);
  });

  it('still guards in memory when storage is unavailable', () => {
    const claims = createDeepLinkClaims(null);
    expect(claims.claim(URL_A)).toBe(true);
    expect(claims.claim(URL_A)).toBe(false);
  });

  it('never throws when storage denies access, and keeps guarding', () => {
    const storage = fakeStorage();
    storage.denied = true;
    const claims = createDeepLinkClaims(storage);
    expect(() => claims.claim(URL_A)).not.toThrow();
    expect(claims.claim(URL_A)).toBe(false);
  });

  it('re-arms after a reset', () => {
    const storage = fakeStorage();
    const claims = createDeepLinkClaims(storage);
    expect(claims.claim(URL_A)).toBe(true);
    claims.reset();
    expect(claims.claim(URL_A)).toBe(true);
    expect(storage.raw.get('canari:deeplink:handled')).toBe(URL_A);
  });
});
