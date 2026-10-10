import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMyProfile = vi.fn();
const fetchUserMemberships = vi.fn();
const fetchUserRoleHistory = vi.fn();
const fetchUserParrainage = vi.fn();

vi.mock('$lib/stores/user', () => ({
  fetchMyProfile: (...a: unknown[]) => fetchMyProfile(...a),
  UserProfileFetchError: class extends Error {
    constructor(readonly status: number) {
      super(`status ${status}`);
    }
  },
}));
vi.mock('$lib/profile/api', () => ({
  fetchUserMemberships: (...a: unknown[]) => fetchUserMemberships(...a),
  fetchUserRoleHistory: (...a: unknown[]) => fetchUserRoleHistory(...a),
  fetchUserParrainage: (...a: unknown[]) => fetchUserParrainage(...a),
}));
vi.mock('$lib/utils/Log', () => ({ Log: { d: vi.fn() } }));

import { UserProfileFetchError } from '$lib/stores/user';
import { MyProfileModel } from './myProfileModel.svelte';

const tree = { found: true, parrains: [{ prenom: 'A' }], fillots: [] };

beforeEach(() => {
  vi.clearAllMocks();
  fetchMyProfile.mockResolvedValue({ id: 'u1', displayName: 'Ada' });
  fetchUserMemberships.mockResolvedValue([{ associationId: 'a' }]);
  fetchUserRoleHistory.mockResolvedValue([]);
  fetchUserParrainage.mockResolvedValue(tree);
});

const settled = () => new Promise((r) => setTimeout(r, 0));

describe('MyProfileModel', () => {
  it('loads the identity and the three extras', async () => {
    const model = new MyProfileModel();
    expect(await model.load()).toBe('loaded');
    await settled();
    expect(model.profile?.id).toBe('u1');
    expect(model.memberships).toHaveLength(1);
    expect(model.hasSponsorship).toBe(true);
    expect(model.membershipsLoading).toBe(false);
    expect(model.loading).toBe(false);
  });

  it('answers unauthenticated on a 401 only, by status and never by message', async () => {
    fetchMyProfile.mockRejectedValue(new UserProfileFetchError(401));
    const model = new MyProfileModel();
    expect(await model.load()).toBe('unauthenticated');
    expect(model.error).toBeNull();

    fetchMyProfile.mockRejectedValue(new UserProfileFetchError(500));
    expect(await model.load()).toBe('failed');
    expect(model.error).toBe('failed');

    fetchMyProfile.mockRejectedValue(new TypeError('401 in the sentence'));
    expect(await model.load()).toBe('failed');
  });

  it('one dead extra empties only itself', async () => {
    fetchUserParrainage.mockRejectedValue(new Error('down'));
    const model = new MyProfileModel();
    await model.load();
    await settled();
    expect(model.profile?.id).toBe('u1');
    expect(model.memberships).toHaveLength(1);
    expect(model.parrainage).toBeNull();
    expect(model.hasSponsorship).toBe(false);
    expect(model.parrainageLoading).toBe(false);
  });
});
