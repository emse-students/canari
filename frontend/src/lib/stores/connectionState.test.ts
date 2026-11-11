import { describe, it, expect } from 'vitest';
import { deriveConnectionState } from './slowLink.svelte';

const base = { isLoggedIn: true, isOffline: false, isOfflineSession: false, slow: false };

describe('deriveConnectionState (the avatar ring)', () => {
  it('is green on a healthy link', () => expect(deriveConnectionState(base)).toBe('connected'));
  it('is amber when answers are slow', () =>
    expect(deriveConnectionState({ ...base, slow: true })).toBe('slow'));
  it('is grey offline, and offline wins over slow', () =>
    expect(deriveConnectionState({ ...base, isOffline: true, slow: true })).toBe('offline'));
  it('is grey while an offline unlock is being promoted', () =>
    expect(deriveConnectionState({ ...base, isOfflineSession: true })).toBe('reconnecting'));
  it('is nothing for a logged-out visitor', () =>
    expect(deriveConnectionState({ ...base, isLoggedIn: false, isOffline: true })).toBeNull());
});
