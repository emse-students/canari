<script lang="ts">
  import { Bell } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import { portal } from '$lib/actions/portal';
  import { goto } from '$app/navigation';
  import { createPausableInterval } from '$lib/utils/backgroundPausableInterval';
  import { postNotifStore } from '$lib/stores/postNotifStore.svelte';
  import NotificationRow from '$lib/components/notifications/NotificationRow.svelte';
  import type { PostNotification } from '$lib/posts/api';
  import { notificationHref } from '$lib/posts/notificationTarget';
  import { m } from '$lib/paraglide/messages';

  let open = $state(false);

  /**
   * What was unread when the dropdown opened, held for as long as it stays open.
   *
   * Same reason as the notifications page: opening marks everything read, so a row drawn from
   * `notif.read` loses its accent in the frame after it appears and the reader never sees which
   * ones were new.
   */
  let unreadAtOpen = $state<ReadonlySet<string>>(new Set());

  async function toggle() {
    open = !open;
    if (open) {
      unreadAtOpen = new Set(postNotifStore.notifications.filter((n) => !n.read).map((n) => n.id));
      await postNotifStore.markAllRead();
    }
  }

  function openNotification(notif: PostNotification) {
    open = false;
    void goto(notificationHref(notif));
  }

  onMount(() => {
    void postNotifStore.load();
    return createPausableInterval(() => void postNotifStore.load(), 60_000);
  });
</script>

<div class="relative">
  <button
    type="button"
    onclick={toggle}
    title={m.nav_notifications_label()}
    aria-label={m.nav_notifications_label()}
    class="text-text-muted hover:text-text hover:bg-cn-surface relative flex h-9 w-9 items-center justify-center rounded-full transition-colors"
  >
    <Bell size={18} strokeWidth={2} />
    {#if postNotifStore.unread > 0}
      <span
        class="text-2xs absolute -top-0.5 -right-0.5 flex h-[1.1rem] min-w-[1.1rem] items-center justify-center rounded-full bg-red-500 px-0.5 font-bold text-white"
      >
        {postNotifStore.unread > 9 ? '9+' : postNotifStore.unread}
      </span>
    {/if}
  </button>

  {#if open}
    <div
      use:portal
      role="presentation"
      class="fixed inset-0 z-(--z-popover-scrim)"
      onclick={() => (open = false)}
    ></div>

    <div
      use:portal
      class="border-cn-border bg-cn-surface fixed top-[calc(env(safe-area-inset-top,0px)+3.5rem)] right-4 z-(--z-popover) w-80 overflow-hidden rounded-xl border shadow-2xl"
    >
      <div class="border-cn-border flex items-center justify-between border-b px-4 py-3">
        <span class="text-sm font-semibold">{m.notif_bell_heading()}</span>
        {#if postNotifStore.notifications.some((n) => !n.read)}
          <span class="text-text-muted text-xs">{m.notif_bell_mark_read()}</span>
        {/if}
      </div>

      {#if postNotifStore.notifications.length === 0}
        <p class="text-text-muted px-4 py-6 text-center text-sm">{m.notif_bell_empty()}</p>
      {:else}
        <ul class="max-h-96 overflow-y-auto p-1">
          {#each postNotifStore.notifications as notif (notif.id)}
            <li>
              <NotificationRow
                {notif}
                unread={unreadAtOpen.has(notif.id)}
                compact
                onOpen={() => openNotification(notif)}
              />
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
