import { describe, it, expect } from 'vitest';
import { connectionRingClass, deriveConnectionState } from './slowLink.svelte';

const base = {
  isLoggedIn: true,
  isOffline: false,
  isOfflineSession: false,
  followerWithoutLeaderSocket: false,
  slow: false,
};

describe('deriveConnectionState (the avatar ring)', () => {
  it('is green on a healthy link', () => expect(deriveConnectionState(base)).toBe('connected'));
  it('is amber when answers are slow', () =>
    expect(deriveConnectionState({ ...base, slow: true })).toBe('slow'));
  it('is grey offline, and offline wins over slow', () =>
    expect(deriveConnectionState({ ...base, isOffline: true, slow: true })).toBe('offline'));
  it('is grey while an offline unlock is being promoted', () =>
    expect(deriveConnectionState({ ...base, isOfflineSession: true })).toBe('reconnecting'));
  it('is grey for a follower tab whose leader has no open socket, and amber slow does not hide it', () =>
    expect(deriveConnectionState({ ...base, followerWithoutLeaderSocket: true, slow: true })).toBe(
      'reconnecting'
    ));
  it('is nothing for a logged-out visitor', () =>
    expect(deriveConnectionState({ ...base, isLoggedIn: false, isOffline: true })).toBeNull());

  it('draws green, amber or grey, as a circle ring colour', () => {
    expect(connectionRingClass('connected')).toBe('ring-green-ok');
    expect(connectionRingClass('slow')).toBe('ring-amber-warn');
    expect(connectionRingClass('offline')).toBe('ring-text-muted');
    expect(connectionRingClass('reconnecting')).toBe('ring-text-muted');
    expect(connectionRingClass(null)).toContain('ring-transparent');
  });
});
