/**
 * A person's profile was five round trips deep (dev, 500 ms RTT, 2026-11-10): the profile, then
 * associations, then role history, then the entourage, each waiting for the one before. The three
 * reads under the profile now leave together, with the profile read. Nothing here reads a clock:
 * the reads are held unanswered and what is asserted is that all three were sent.
 */
import { describe, expect, it, vi } from 'vitest';
import { readSource } from '../../test/sourceTree';

const memberships = vi.fn();
const roleHistory = vi.fn();
const parrainage = vi.fn();
vi.mock('$lib/profile/api', () => ({
  fetchUserMemberships: (id: string) => memberships(id),
  fetchUserRoleHistory: (id: string) => roleHistory(id),
  fetchUserParrainage: (id: string) => parrainage(id),
}));

const { readProfileExtras, readProfileWithExtras } = await import('./profileExtras');

const never = () => new Promise<never>(() => {});

describe('readProfileExtras', () => {
  it('sends the three reads at once, none waiting for another', () => {
    memberships.mockImplementation(never);
    roleHistory.mockImplementation(never);
    parrainage.mockImplementation(never);

    readProfileExtras('u1');

    expect(memberships).toHaveBeenCalledWith('u1');
    expect(roleHistory).toHaveBeenCalledWith('u1');
    expect(parrainage).toHaveBeenCalledWith('u1');
  });

  it('a failed section resolves to its empty value, and the others keep theirs', async () => {
    memberships.mockRejectedValue(new TypeError('Failed to fetch'));
    roleHistory.mockResolvedValue([{ role: 'r' }]);
    parrainage.mockRejectedValue(new Error('refused'));

    const reads = readProfileExtras('u2');

    expect(await reads.memberships).toEqual([]);
    expect(await reads.roleHistory).toEqual([{ role: 'r' }]);
    expect(await reads.parrainage).toBeNull();
  });
});

describe('readProfileWithExtras', () => {
  it('has the three extras on the wire while the profile read is still unanswered', async () => {
    memberships.mockClear().mockResolvedValue([{ id: 'm' }]);
    roleHistory.mockClear().mockResolvedValue([]);
    parrainage.mockClear().mockResolvedValue(null);
    let answerProfile: (p: string) => void = () => {};
    const readProfile = vi.fn(() => new Promise<string>((r) => (answerProfile = r)));

    const { profile, extras } = readProfileWithExtras('u3', readProfile);

    // The profile has NOT answered, and every extra has already left - and already settled.
    expect(readProfile).toHaveBeenCalledTimes(1);
    expect(memberships).toHaveBeenCalledWith('u3');
    expect(roleHistory).toHaveBeenCalledWith('u3');
    expect(parrainage).toHaveBeenCalledWith('u3');
    expect(await extras.memberships).toEqual([{ id: 'm' }]);

    answerProfile('the profile');
    expect(await profile).toBe('the profile');
  });

  it('the profile page loads through it, and fetches nothing under the profile by itself', () => {
    const page = readSource('src/routes/profile/[id]/+page.svelte');
    expect(page).toContain('readProfileWithExtras(userId,');
    expect(page).not.toMatch(/fetchUser(Memberships|RoleHistory|Parrainage)\(/);
  });
});
