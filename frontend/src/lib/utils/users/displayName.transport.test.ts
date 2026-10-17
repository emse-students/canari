import { connectivity } from '$lib/stores/connectivity.svelte';
import { TransportFailureError } from '$lib/utils/transportFailure';

/**
 * A profile lookup that got NO ANSWER is evidence about the network, not about the user.
 *
 * The Mi 9T's offline cold start (`v1.2.9-alpha.1`, 2026-10-15) printed `[DISPLAYNAME] profile fetch
 * failed - this user renders as "unknown" for the next 120s with no retry` once per user, six times,
 * each counted into the failure rate that exists to judge a REFUSING server - and the "120s with no
 * retry" was false, since the reconnect clears the backoff.
 */

const fetchUserProfile = vi.fn();
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'me',
  fetchUserProfile: (...args: unknown[]) => fetchUserProfile(...args),
  getSavedDisplayName: () => null,
  isAbsentUserError: () => false,
}));

const { resolveUserDisplayName, displayNameLookupStats } = await import('./displayName');

describe('resolveUserDisplayName when the server gives no answer', () => {
  it('says so ONCE per spell, counts no failure, and asks again after the reconnect', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    fetchUserProfile.mockRejectedValue(new TransportFailureError('Failed to fetch'));

    expect(await resolveUserDisplayName('user-a')).toBeNull();
    expect(await resolveUserDisplayName('user-b')).toBeNull();
    expect(await resolveUserDisplayName('user-c')).toBeNull();

    const noAnswer = () => warn.mock.calls.filter(([m]) => String(m).includes('get no answer'));
    expect(noAnswer()).toHaveLength(1);
    expect(warn.mock.calls.some(([m]) => String(m).includes('profile fetch failed'))).toBe(false);
    expect(displayNameLookupStats().failed).toBe(0);

    // The server answers again: the backoff recorded for the dead link is void.
    connectivity.notifyServerUnreachable();
    connectivity.notifyServerReachable();
    fetchUserProfile.mockResolvedValue({ firstName: 'Ada', lastName: 'Lovelace' });
    expect(await resolveUserDisplayName('user-a')).toBe('Ada Lovelace');

    // A new spell is said again.
    fetchUserProfile.mockRejectedValue(new TransportFailureError('Failed to fetch'));
    connectivity.notifyServerUnreachable();
    connectivity.notifyServerReachable();
    expect(await resolveUserDisplayName('user-d')).toBeNull();
    expect(noAnswer()).toHaveLength(2);
  });

  it('keeps accusing a plain TypeError: a programming bug is not "no answer"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchUserProfile.mockRejectedValue(
      new TypeError("Cannot read properties of undefined (reading 'id')")
    );

    expect(await resolveUserDisplayName('user-bug')).toBeNull();

    expect(warn.mock.calls.some(([m]) => String(m).includes('profile fetch failed'))).toBe(true);
    expect(displayNameLookupStats().failed).toBe(1);
  });
});
