vi.mock('$lib/paraglide/messages', () => ({
  m: { user_unknown_label: () => 'Utilisateur inconnu' },
}));
vi.mock('$lib/stores/user', () => ({
  currentUserId: vi.fn(() => null),
  getSavedDisplayName: vi.fn(() => null),
  fetchUserProfile: vi.fn(),
  isAbsentUserError: () => false,
}));

import { flushSync } from 'svelte';
import * as userStore from '$lib/stores/user';
import { getUserFirstNameSync, resolveUserDisplayName, seedUserDisplayName } from './displayName';

describe('first name reactivity', () => {
  it('a $derived reading getUserFirstNameSync recomputes when the profile lands', async () => {
    vi.mocked(userStore.fetchUserProfile).mockResolvedValue({
      id: 'usr_c',
      displayName: null,
      firstName: 'Ada',
      lastName: 'Lovelace',
    } as never);
    seedUserDisplayName('usr_c', 'Ada Lovelace');
    const seen: string[] = [];
    const stop = $effect.root(() => {
      const label = $derived(getUserFirstNameSync('usr_c', 'Ada Lovelace'));
      $effect(() => {
        seen.push(label);
      });
    });
    flushSync();
    await resolveUserDisplayName('usr_c');
    flushSync();
    stop();
    expect(seen).toEqual(['Ada Lovelace', 'Ada']);
  });
});
