<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import { Megaphone } from '@lucide/svelte';
  import {
    getPendingAnnouncement,
    dismissAnnouncement,
    refreshAnnouncement,
  } from '$lib/stores/announcement.svelte';
  import { currentUserId } from '$lib/stores/user';
  import {
    isBelowMinClientVersion,
    isMaintenanceBlockingCurrentUser,
  } from '$lib/stores/appVersionCheck.svelte';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { m } from '$lib/paraglide/messages';

  /**
   * Blocked means the app is unusable behind a gate (below the minimum version, or maintenance).
   * An announcement stacked on top of one of those would cover the instruction the user has to
   * follow to get out, so it waits for the next opening instead - the "seen" state is server-side,
   * so waiting costs nothing.
   */
  const blocked = $derived(
    isBelowMinClientVersion() || isMaintenanceBlockingCurrentUser(isGlobalAdmin())
  );

  const announcement = $derived(getPendingAnnouncement());

  let dismissing = $state(false);

  // One ask per app opening, and only once there IS an account to ask on behalf of: the endpoint
  // is authenticated, so asking before sign-in would spend a 401 to learn nothing.
  $effect(() => {
    if (!currentUserId() || blocked) return;
    void refreshAnnouncement();
  });

  async function close() {
    dismissing = true;
    try {
      await dismissAnnouncement();
    } finally {
      dismissing = false;
    }
  }
</script>

{#if announcement && !blocked}
  <Modal
    open={true}
    title={announcement.title}
    dismissible={false}
    maxWidth="max-w-lg"
    onClose={() => {}}
  >
    <div class="flex gap-3">
      <span
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cn-yellow/15 text-cn-dark"
      >
        <Megaphone size={20} />
      </span>
      <!-- Plain text with its line breaks kept: an announcement is typed in a textarea, and
           rendering it as markup would make the admin panel an injection surface. -->
      <p class="text-sm leading-relaxed text-text-main whitespace-pre-wrap wrap-break-word">
        {announcement.body}
      </p>
    </div>

    {#snippet footer()}
      <button
        type="button"
        onclick={() => void close()}
        disabled={dismissing}
        class="px-4 py-2 rounded-xl bg-cn-yellow hover:bg-cn-yellow-hover text-cn-dark text-sm font-bold disabled:opacity-50"
      >
        {m.announcement_understood_button()}
      </button>
    {/snippet}
  </Modal>
{/if}
