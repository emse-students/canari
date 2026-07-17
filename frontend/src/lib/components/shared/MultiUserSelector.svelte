<script lang="ts">
  import { X } from '@lucide/svelte';
  import UserName from './UserName.svelte';
  import UserAutocomplete from './UserAutocomplete.svelte';
  import { seedUserDisplayName } from '$lib/utils/users/displayName';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Array of currently selected user IDs. */
    users: string[];
    /** Called with the updated list whenever a user is added or removed. */
    onUsersChange: (users: string[]) => void;
    /** Placeholder text shown in the search input. */
    placeholder?: string;
  }

  let { users, onUsersChange, placeholder = m.user_search_placeholder() }: Props = $props();

  /**
   * Adds a picked user to the selection. Seeds the display-name cache with the
   * search result's name so the chip shows the name instantly (not the raw ID).
   */
  function handleSelect(user: { id: string; displayName: string | null }) {
    const id = user.id.trim().toLowerCase();
    if (!id || users.includes(id)) return;
    if (user.displayName) seedUserDisplayName(id, user.displayName);
    onUsersChange([...users, id]);
  }

  function removeUser(userToRemove: string) {
    onUsersChange(users.filter((u) => u !== userToRemove));
  }
</script>

<div class="space-y-3">
  <UserAutocomplete
    value=""
    onValueChange={() => {}}
    onSelect={handleSelect}
    clearOnSelect
    excludeIds={users}
    {placeholder}
  />

  {#if users.length > 0}
    <div class="flex flex-wrap gap-2">
      {#each users as user (user)}
        <div
          class="flex items-center gap-1 pl-3 pr-1 py-1 bg-cn-bg text-cn-dark rounded-full text-sm"
        >
          <UserName userId={user} class="text-sm font-medium" />
          <button
            onclick={() => removeUser(user)}
            class="p-1 hover:bg-gray-200 dark:hover:bg-white/10 rounded-full transition-colors"
            aria-label={m.user_selector_remove_label()}
          >
            <X size={14} />
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>
