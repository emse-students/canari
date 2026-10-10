import { getContext, setContext } from 'svelte';
import { Log } from '$lib/utils/Log';
import { fetchMyProfile, UserProfileFetchError, type UserProfile } from '$lib/stores/user';
import {
  fetchUserMemberships,
  fetchUserParrainage,
  fetchUserRoleHistory,
  type SkyEntourage,
  type UserMembershipRow,
  type UserRoleHistoryRow,
} from '$lib/profile/api';

const CONTEXT_KEY = Symbol('myProfileModel');

/** Called once by the `(me)` layout: creates the model and offers it to the pages below. */
export function provideMyProfile(): MyProfileModel {
  const model = new MyProfileModel();
  setContext(CONTEXT_KEY, model);
  return model;
}

/** Read by the hub and every section; throws if used outside the `(me)` layout (a wiring bug). */
export function useMyProfile(): MyProfileModel {
  const model = getContext<MyProfileModel | undefined>(CONTEXT_KEY);
  if (!model) throw new Error('useMyProfile() called outside the profile layout');
  return model;
}

/** How the identity fetch ended, so the caller (which owns navigation) decides what to do. */
export type MyProfileOutcome = 'loaded' | 'unauthenticated' | 'failed';

/**
 * THE READER'S OWN PROFILE AND ITS EXTRAS, loaded once for the hub and every section under it.
 *
 * The profile area is a hub plus route sections, so the identity, memberships, role history and
 * sponsorship tree are needed by more than one page. The `(me)` layout owns ONE instance (put in
 * context), which survives hub -> section navigation and is dropped when the reader leaves the
 * area: a reload on a section fetches again, and nothing is ever shown for a previous account.
 *
 * Each extra loads on its own and a failure empties only that extra (logged): a dead sponsorship
 * endpoint must not blank the identity block.
 */
export class MyProfileModel {
  profile = $state<UserProfile | null>(null);
  loading = $state(true);
  error = $state<'failed' | null>(null);
  memberships = $state<UserMembershipRow[]>([]);
  membershipsLoading = $state(false);
  roleHistory = $state<UserRoleHistoryRow[]>([]);
  roleHistoryLoading = $state(false);
  parrainage = $state<SkyEntourage | null>(null);
  parrainageLoading = $state(false);

  /** The sponsorship tree has someone in it (its section exists only then). */
  get hasSponsorship(): boolean {
    return (this.parrainage?.parrains.length ?? 0) + (this.parrainage?.fillots.length ?? 0) > 0;
  }

  /** Fetches the identity, then the extras in the background. */
  async load(): Promise<MyProfileOutcome> {
    this.loading = true;
    this.error = null;
    try {
      this.profile = await fetchMyProfile();
      void this.loadExtras(this.profile.id);
      return 'loaded';
    } catch (err) {
      Log.d('profile.load failed', err);
      // A STATUS CODE IS AN ANSWER: only a 401 sends the reader to sign in, and it is read from the
      // typed error, never from the sentence the server wrote.
      if (err instanceof UserProfileFetchError && err.status === 401) return 'unauthenticated';
      this.error = 'failed';
      return 'failed';
    } finally {
      this.loading = false;
    }
  }

  private async loadExtras(userId: string): Promise<void> {
    this.membershipsLoading = true;
    this.roleHistoryLoading = true;
    this.parrainageLoading = true;
    await Promise.all([
      this.settle('memberships', fetchUserMemberships(userId), (v) => (this.memberships = v), []),
      this.settle('roleHistory', fetchUserRoleHistory(userId), (v) => (this.roleHistory = v), []),
      this.settle('parrainage', fetchUserParrainage(userId), (v) => (this.parrainage = v), null),
    ]);
    this.membershipsLoading = false;
    this.roleHistoryLoading = false;
    this.parrainageLoading = false;
  }

  /** One extra's fetch: store the answer, or log and store the empty value (isolation per extra). */
  private async settle<T>(
    name: string,
    request: Promise<T>,
    store: (value: T) => void,
    empty: T
  ): Promise<void> {
    try {
      store(await request);
    } catch (err) {
      Log.d(`profile.${name} failed`, err);
      store(empty);
    }
  }

  /** Re-reads the role history after an edit. */
  async reloadRoleHistory(): Promise<void> {
    if (!this.profile?.id) return;
    this.roleHistoryLoading = true;
    try {
      this.roleHistory = await fetchUserRoleHistory(this.profile.id);
    } finally {
      this.roleHistoryLoading = false;
    }
  }
}
