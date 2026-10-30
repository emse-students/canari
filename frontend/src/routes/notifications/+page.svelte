<script lang="ts">
  import { internalPath } from '$lib/utils/internalPath';
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { BellOff, Repeat2, UserPlus } from '@lucide/svelte';
  import { postNotifStore } from '$lib/stores/postNotifStore.svelte';
  import NotificationRow from '$lib/components/notifications/NotificationRow.svelte';
  import DeviceNoticeRow from '$lib/components/notifications/DeviceNoticeRow.svelte';
  import { pendingDeviceNotices } from '$lib/utils/chat/deviceNotices.svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import {
    groupNotifications,
    groupNotificationsByPost,
    type NotificationBucket,
  } from '$lib/utils/notifications/grouping';
  import type { PostNotification } from '$lib/posts/api';
  import {
    FOLLOW_REQUESTS_ROUTE,
    REPUBLICATION_REQUESTS_ROUTE,
    resolveNotificationHref,
  } from '$lib/posts/notificationTarget';
  import { countMyRepublicationRequests } from '$lib/proposals/api';
  import { countFollowRequests } from '$lib/follows/api';
  import { getAssociation } from '$lib/associations/api';
  import { showToast } from '$lib/stores/toast.svelte';
  import { Log } from '$lib/utils/Log';
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

  /**
   * How many republication requests wait on this reader (D38b) - the link to their inbox is drawn
   * only when there is something in it. A failed count draws no link and says why in the log; the
   * notification and the push still lead there.
   */
  let pendingRequests = $state(0);
  /** How many follow requests wait on this reader (WP-F4), drawn the same way. */
  let pendingFollowRequests = $state(0);

  onMount(() => {
    countMyRepublicationRequests()
      .then((count) => (pendingRequests = count))
      .catch((e: unknown) => Log.d('notifications', `request count failed: ${String(e)}`));
    countFollowRequests()
      .then((count) => (pendingFollowRequests = count))
      .catch((e: unknown) => Log.d('notifications', `follow request count failed: ${String(e)}`));
  });

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

  /** The new-device alerts of this account, raised on this device (never fetched). */
  const deviceNotices = $derived(pendingDeviceNotices());

  const groups = $derived(
    groupNotifications(groupNotificationsByPost(visible), unreadAtOpen, openedAt)
  );

  /** The heading for a band. A map rather than a chain: the buckets are a closed set. */
  const BUCKET_LABEL: Record<NotificationBucket, () => string> = {
    new: () => m.notif_group_new(),
    today: () => m.notif_group_today(),
    week: () => m.notif_group_week(),
    earlier: () => m.notif_group_earlier(),
  };

  /** Resolves where the row goes (a slug lookup for an association's queue), then goes there. */
  async function openNotification(notif: PostNotification) {
    try {
      const url = await resolveNotificationHref(
        notif,
        async (id) => (await getAssociation(id)).slug
      );
      if (!url) {
        Log.d('notifications', `open ${notif.type}: no destination`);
        return;
      }
      await goto(resolve(internalPath(url)));
    } catch (e: unknown) {
      Log.d('notifications', `open ${notif.type} failed: ${String(e)}`);
      showToast(m.notif_open_error());
    }
  }
</script>

<!--
  THE LIST SITS ON THE PAGE GROUND, NOT ON A CARD.

  It was a `md:bg-cn-surface` panel for one day. Two things were wrong with that, both reported by
  the user: the card was a white slab no other page draws, and the column under it was `max-w-xl` -
  576px against the feed's 680px - so the app's narrowest page was the one made of the widest rows.
  The reference draws its notifications as a panel because there it IS a dropdown floating over a
  page; here it is the page.
-->
<PageContainer>
  <PageHeader title={m.nav_notifications_label()}>
    <!-- The two pills, which the reference puts directly under the title. -->
    <div class="flex items-center gap-2">
      {#each [{ key: 'all', label: m.notif_filter_all() }, { key: 'unread', label: m.notif_filter_unread() }] as tab (tab.key)}
        <button
          type="button"
          onclick={() => (filter = tab.key as 'all' | 'unread')}
          aria-pressed={filter === tab.key}
          class="tap-target rounded-full px-3 py-1.5 text-sm font-semibold transition-colors {filter ===
          tab.key
            ? 'bg-cn-yellow text-cn-ink'
            : 'text-text-muted hover:bg-black/5 dark:hover:bg-white/10'}"
        >
          {tab.label}
        </button>
      {/each}
    </div>
  </PageHeader>

  {#if pendingFollowRequests > 0}
    <a
      href={resolve(FOLLOW_REQUESTS_ROUTE)}
      class="border-cn-border bg-cn-surface text-text-main mb-3 flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition-colors hover:border-amber-400"
    >
      <UserPlus size={16} strokeWidth={2.5} class="shrink-0 text-amber-600 dark:text-amber-400" />
      {m.follow_requests_banner({ count: pendingFollowRequests })}
    </a>
  {/if}

  {#if pendingRequests > 0}
    <a
      href={resolve(REPUBLICATION_REQUESTS_ROUTE)}
      class="border-cn-border bg-cn-surface text-text-main mb-3 flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition-colors hover:border-amber-400"
    >
      <Repeat2 size={16} strokeWidth={2.5} class="shrink-0 text-amber-600 dark:text-amber-400" />
      {m.republication_requests_banner({ count: pendingRequests })}
    </a>
  {/if}

  <!--
    THE DEVICE ALERTS, LOCAL AND FIRST. "A new device was added to your account" is built on THIS
    device from a signed commit, so it is not in the server's list and is never sent to it. It is
    unread by definition until the owner has seen it, so it sits above the date bands (and stays
    under the "unread" pill) and counts in the bell's badge (`postNotifStore.unread`).
  -->
  {#if deviceNotices.length > 0}
    <ul class="mb-2 flex flex-col" data-device-notices>
      {#each deviceNotices as notice (notice.key)}
        <li><DeviceNoticeRow {notice} /></li>
      {/each}
    </ul>
  {/if}

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
  {:else if groups.length === 0 && deviceNotices.length === 0}
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
              actorNames={notif.actorNames}
              unread={notif.notificationIds.some((id) => unreadAtOpen.has(id))}
              onOpen={() => openNotification(notif)}
            />
          </li>
        {/each}
      </ul>
    {/each}
  {/if}
</PageContainer>
