// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '$lib/stores/user';

const sealed = vi.hoisted(() => ({ rows: new Map<string, unknown>() }));

vi.mock('$lib/stores/user', () => ({ getSavedUserId: () => 'me' }));
vi.mock('$lib/db', () => ({
  // One database per account, as on a device.
  getStorage: async (userId: string) => ({
    saveFeedPage: async (key: string, payload: unknown) => {
      sealed.rows.set(`${userId}/${key}`, JSON.parse(JSON.stringify(payload)));
    },
    getFeedPage: async (key: string) => sealed.rows.get(`${userId}/${key}`) ?? null,
    deleteFeedPage: async (key: string) => (sealed.rows.delete(`${userId}/${key}`) ? 1 : 0),
  }),
}));

import { PROFILES_SLOT, bindLocalCopies } from '$lib/localCopies/localCopyStore.svelte';
import { endPeerNames } from '$lib/utils/users/peerNameDirectory';
import {
  MAX_STORED_PROFILES,
  forgetProfileCopy,
  readProfileCopy,
  rememberProfile,
  type ProfileCopy,
} from './profileCopies';

const ME = { userId: 'me', deviceKeyB64: 'KEY' };
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};
const copy = (id: string, extra: Record<string, unknown> = {}): ProfileCopy => ({
  profile: { id, displayName: `Name ${id}`, bio: null, ...extra } as unknown as UserProfile,
  memberships: [],
  roleHistory: [],
});

/** A cold start: memory emptied by another account's bind, then this account opens again. */
async function restart() {
  bindLocalCopies({ userId: 'other', deviceKeyB64: 'K2' });
  await settle();
  bindLocalCopies(ME);
  await settle();
}

describe('profileCopies', () => {
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.clear();
    sealed.rows.clear();
    bindLocalCopies(null);
    bindLocalCopies(ME);
    await settle();
  });

  it('draws a profile seen before from the device after a cold start, no network involved', async () => {
    await rememberProfile(copy('p1'));
    await settle();
    expect(JSON.stringify({ ...localStorage })).not.toContain('Name p1');
    await restart();
    expect((await readProfileCopy('p1'))?.profile.displayName).toBe('Name p1');
    expect(await readProfileCopy('p2')).toBeNull();
  });

  it('does not keep the posts of a profile, nor draw a copy with no key in hand', async () => {
    await rememberProfile(copy('p1', { posts: [{ id: 'x' }] }));
    await settle();
    const stored = sealed.rows.get(`me/${PROFILES_SLOT}`) as {
      body: { profiles: { profile: Record<string, unknown> }[] };
    };
    expect(stored.body.profiles[0].profile.posts).toBeUndefined();
    bindLocalCopies(null);
    expect(await readProfileCopy('p1')).toBeNull();
  });

  it('keeps the newest profiles only, the oldest leaving first, a reopened one moving to the front', async () => {
    for (let i = 0; i < MAX_STORED_PROFILES + 3; i++) {
      await rememberProfile(copy(`p${i}`));
      if (i === 5) await rememberProfile(copy('p0')); // p0 opened again: newest
    }
    await settle();
    await restart();
    expect(await readProfileCopy('p0')).not.toBeNull();
    expect(await readProfileCopy('p1')).toBeNull();
    expect(await readProfileCopy(`p${MAX_STORED_PROFILES + 2}`)).not.toBeNull();
    const stored = sealed.rows.get(`me/${PROFILES_SLOT}`) as { body: { profiles: unknown[] } };
    expect(stored.body.profiles).toHaveLength(MAX_STORED_PROFILES);
  });

  it('forgets a profile the server said is gone', async () => {
    await rememberProfile(copy('p1'));
    await settle();
    forgetProfileCopy('p1');
    await settle();
    await restart();
    expect(await readProfileCopy('p1')).toBeNull();
  });

  it('never draws a profile for another account, nor after a sign-out', async () => {
    await rememberProfile(copy('p1'));
    await settle();
    bindLocalCopies({ userId: 'other', deviceKeyB64: 'K2' });
    await settle();
    expect(await readProfileCopy('p1')).toBeNull();
    bindLocalCopies(ME);
    await settle();
    endPeerNames('sign-out');
    await restart();
    expect(await readProfileCopy('p1')).toBeNull();
  });
});
