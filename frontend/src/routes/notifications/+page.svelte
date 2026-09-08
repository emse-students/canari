<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { BellOff } from '@lucide/svelte';
  import { postNotifStore } from '$lib/stores/postNotifStore.svelte';
  import NotificationRow from '$lib/components/notifications/NotificationRow.svelte';
  import { groupNotifications, type NotificationBucket } from '$lib/utils/notifications/grouping';
  import type { PostNotification } from '$lib/posts/api';
  import { m } from '$lib/paraglide/messages';

  /**
   * WHAT WAS UNREAD WHEN THIS VIEW OPENED, captured before the read receipt goes out.
   *
   * Opening this page marks everything read, so `notif.read` is `true` for the whole list within a
   * frame and there is nothing left to tell the reader what they came to see. The server still gets
   * the receipt - the bell has to clear - but the band and the accent are drawn from this snapshot,
   * which lives as long as the view does.
   */
  let unreadAtOpen = $state<ReadonlySet<string>>(new Set());

  /** `all` or `unread`, mirroring the reference's two pills. */
  let filter = $state<'all' | 'unread'>('all');

  /**
   * The reference instant for the date bands, taken once at open.
   *
   * Reading the clock inside the grouping would re-bucket rows under the user while they read - at
   * midnight, silently - and would make the derivation impure.
   */
  let openedAt = $state(new Date());

  onMount(() => {
    /*
     * SEQUENCED, AND THAT IS THE FIX RATHER THAN THE STYLE.
     *
     * These two were fired side by side without awaiting. `markAllRead` guards on
     * `notifications.every((n) => n.read)`, and `[].every(...)` is TRUE - so on a cold load, where
     * the store is empty until `load` resolves, the guard returned immediately and the receipt was
     * never sent. Opening this page did not clear the badge. The bell hid it: by the time a
     * dropdown opens the store is populated, so that path always worked.
     */
    void (async () => {
      await postNotifStore.load(50);
      openedAt = new Date();
      unreadAtOpen = new Set(postNotifStore.notifications.filter((n) => !n.read).map((n) => n.id));
      await postNotifStore.markAllRead();
    })();
  });

  const visible = $derived(
    filter === 'unread'
      ? postNotifStore.notifications.filter((n) => unreadAtOpen.has(n.id))
      : postNotifStore.notifications
  );

  const groups = $derived(groupNotifications(visible, unreadAtOpen, openedAt));

  /** The heading for a band. A map rather than a chain: the buckets are a closed set. */
  const BUCKET_LABEL: Record<NotificationBucket, () => string> = {
    new: () => m.notif_group_new(),
    today: () => m.notif_group_today(),
    week: () => m.notif_group_week(),
    earlier: () => m.notif_group_earlier(),
  };

  function openNotification(notif: PostNotification) {
    const url =
      notif.type === 'form_reminder' ? `/forms/${notif.postId}` : `/posts/${notif.postId}`;
    void goto(url);
  }
</script>

<svelte:head>
  <title>{m.nav_notifications_label()} - Canari</title>
</svelte:head>

<!--
  ON DESKTOP THE LIST IS A CARD, like every other region of the shell and like the reference, which
  draws its notification column as a panel on the page ground rather than as text floating on it.
  Below 768px it stays full-bleed: the shell does not float anything there either, because a phone
  has no width to spend on a gutter.
-->
<main class="mx-auto max-w-xl px-4 py-6 pb-24 md:px-0 md:pb-8">
  <div class="md:bg-cn-surface md:rounded-xl md:px-4 md:py-5">
    <h1 class="text-text-main text-xl font-bold">{m.nav_notifications_label()}</h1>

    <!-- The two pills, which the reference puts directly under the title. -->
    <div class="mt-3 mb-4 flex items-center gap-2">
      {#each [{ key: 'all', label: m.notif_filter_all() }, { key: 'unread', label: m.notif_filter_unread() }] as tab (tab.key)}
        <button
          type="button"
          onclick={() => (filter = tab.key as 'all' | 'unread')}
          aria-pressed={filter === tab.key}
          class="rounded-full px-3 py-1.5 text-sm font-semibold transition-colors {filter ===
          tab.key
            ? 'bg-cn-yellow text-cn-ink'
            : 'text-text-muted hover:bg-black/5 dark:hover:bg-white/10'}"
        >
          {tab.label}
        </button>
      {/each}
    </div>

    {#if postNotifStore.loading && postNotifStore.notifications.length === 0}
      <div class="flex flex-col gap-3">
        {#each { length: 6 } as _, i (i)}
          <div class="flex animate-pulse items-start gap-3 px-2 py-2.5">
            <div class="bg-cn-surface h-14 w-14 shrink-0 rounded-full"></div>
            <div class="flex-1 space-y-2 py-1">
              <div class="bg-cn-surface h-3 w-3/4 rounded"></div>
              <div class="bg-cn-surface h-2.5 w-1/3 rounded"></div>
            </div>
          </div>
        {/each}
      </div>
    {:else if groups.length === 0}
      <div class="text-text-muted flex flex-col items-center gap-3 py-16">
        <BellOff size={40} strokeWidth={1.5} class="opacity-40" />
        <p class="text-sm">
          {filter === 'unread' ? m.notif_empty_unread() : m.notif_empty_message()}
        </p>
      </div>
    {:else}
      {#each groups as group (group.bucket)}
        <h2 class="text-text-main mt-4 mb-1 px-2 text-base font-bold first:mt-0">
          {BUCKET_LABEL[group.bucket]()}
        </h2>
        <ul class="flex flex-col">
          {#each group.items as notif (notif.id)}
            <li>
              <NotificationRow
                {notif}
                unread={unreadAtOpen.has(notif.id)}
                onOpen={() => openNotification(notif)}
              />
            </li>
          {/each}
        </ul>
      {/each}
    {/if}
  </div>
</main>
