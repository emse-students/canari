<script lang="ts">
  import { onMount } from 'svelte';
  import { Ban, LoaderCircle } from '@lucide/svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import { listBlockedUsers, unblockUser, type BlockedUser } from '$lib/users/blocks';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  /**
   * The people this account has blocked, and the only place a block can be lifted.
   *
   * It has to exist HERE rather than only on each profile: a blocked person is hidden from the user
   * search, so somebody who wanted to undo a block would have no way to reach the profile that
   * offers it. The list carries the names for exactly that reason.
   */
  let blocked = $state<BlockedUser[]>([]);
  let loading = $state(true);
  let error = $state('');
  let pendingId = $state<string | null>(null);

  onMount(load);

  async function load() {
    loading = true;
    error = '';
    try {
      blocked = await listBlockedUsers();
    } catch (err) {
      Log.d('SettingsBlockedSection.load failed', err);
      error = m.settings_blocked_load_error();
    } finally {
      loading = false;
    }
  }

  async function handleUnblock(userId: string) {
    pendingId = userId;
    error = '';
    try {
      await unblockUser(userId);
      blocked = blocked.filter((b) => b.userId !== userId);
    } catch (err) {
      Log.d('SettingsBlockedSection.handleUnblock failed', err);
      error = m.settings_blocked_unblock_error();
    } finally {
      pendingId = null;
    }
  }
</script>

<div
  class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm delay-250 duration-500 md:p-8"
  style="animation-fill-mode: backwards;"
>
  <div class="mb-6 flex items-center gap-3">
    <div class="rounded-xl bg-red-500/10 p-2.5 text-red-600 dark:text-red-400">
      <Ban size={22} strokeWidth={2.5} />
    </div>
    <div>
      <h2 class="text-text-main text-lg font-extrabold">{m.settings_blocked_heading()}</h2>
      <p class="text-text-muted mt-0.5 text-xs font-medium">
        {m.settings_blocked_subtitle()}
      </p>
    </div>
  </div>

  {#if error}
    <p class="mb-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm font-medium text-red-600">{error}</p>
  {/if}

  {#if loading}
    <div class="text-text-muted flex items-center gap-3 py-2 text-sm font-semibold">
      <LoaderCircle size={18} class="animate-spin" />
      {m.common_loading_label()}
    </div>
  {:else if blocked.length === 0}
    <p class="text-text-muted text-sm font-medium">{m.settings_blocked_empty()}</p>
  {:else}
    <ul class="space-y-2">
      {#each blocked as person (person.userId)}
        <li
          class="flex items-center gap-3 rounded-xl border border-black/5 bg-black/[0.02] px-3 py-2.5 dark:border-white/10 dark:bg-white/[0.02]"
        >
          <div class="h-9 w-9 shrink-0 overflow-hidden rounded-full">
            <Avatar userId={person.userId} fill shape="circle" />
          </div>
          <span class="text-text-main min-w-0 flex-1 truncate text-sm font-semibold">
            {person.displayName ?? person.userId}
          </span>
          <button
            type="button"
            onclick={() => handleUnblock(person.userId)}
            disabled={pendingId === person.userId}
            class="text-text-main shrink-0 rounded-lg bg-black/5 px-3 py-1.5 text-xs font-bold transition-colors hover:bg-black/10 disabled:opacity-50 dark:bg-white/10 dark:hover:bg-white/20"
          >
            {m.settings_blocked_unblock_button()}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
