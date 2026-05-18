<script lang="ts">
  import { Bell } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import { portal } from '$lib/actions/portal';
  import { goto } from '$app/navigation';
  import { getPostNotifications, markPostNotificationsRead } from '$lib/posts/api';
  import type { PostNotification } from '$lib/posts/api';
  import { formatRelative } from '$lib/utils/time';
  import { createPausableInterval } from '$lib/utils/backgroundPausableInterval';

  interface Props {
    /**
     * Quand true, rendu adapté à la BottomNav mobile : icône agrandie + label "Notifs",
     * couleur active si non lus. Le panneau se positionne au-dessus de la nav.
     */
    mobile?: boolean;
  }
  const { mobile = false }: Props = $props();

  let notifications = $state<PostNotification[]>([]);
  let open = $state(false);
  let unread = $derived(notifications.filter((n) => !n.read).length);

  async function load() {
    try {
      notifications = await getPostNotifications(20);
    } catch {
      // silent
    }
  }

  async function toggle() {
    open = !open;
    if (open && unread > 0) {
      try {
        await markPostNotificationsRead();
        notifications = notifications.map((n) => ({ ...n, read: true }));
      } catch {
        // silent
      }
    }
  }

  function openNotification(notif: PostNotification) {
    open = false;
    const url = notif.type === 'form_reminder' ? `/forms/${notif.postId}` : `/posts/${notif.postId}`;
    void goto(url);
  }

  onMount(() => {
    return createPausableInterval(() => void load(), 60_000);
  });
</script>

<div class="relative {mobile ? 'flex-1 flex flex-col items-center' : ''}">
  <button
    type="button"
    onclick={toggle}
    title="Notifications"
    aria-label="Notifications"
    class={mobile
      ? `relative flex flex-col items-center justify-center gap-1 min-w-0 w-full py-1 px-1 transition-all duration-200 active:scale-95 ${unread > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-text-muted hover:text-text-main'}`
      : 'relative flex items-center justify-center w-9 h-9 rounded-full text-text-muted hover:text-text hover:bg-cn-surface transition-colors'}
  >
    <span class="relative {mobile ? 'transition-transform duration-300' : ''}">
      <Bell size={mobile ? 24 : 18} strokeWidth={mobile && unread > 0 ? 2.5 : 2} />
      {#if unread > 0}
        <span
          class={mobile
            ? 'absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white dark:ring-[#151B2C] shadow-sm'
            : 'absolute -top-0.5 -right-0.5 min-w-[1.1rem] h-[1.1rem] flex items-center justify-center rounded-full bg-red-500 text-white text-[0.6rem] font-bold px-0.5'}
        >
          {#if !mobile}{unread > 9 ? '9+' : unread}{/if}
        </span>
      {/if}
    </span>
    {#if mobile}
      <span class="text-[10px] font-bold leading-none truncate {unread > 0 ? 'opacity-100' : 'opacity-70 font-medium'}">
        Notifs
      </span>
    {/if}
  </button>

  {#if open}
    <!-- backdrop -->
    <div
      use:portal
      role="presentation"
      class="fixed inset-0 z-[190]"
      onclick={() => (open = false)}
    ></div>

    <div
      use:portal
      class="fixed z-[200] rounded-xl border border-cn-border bg-white dark:bg-[#0f1622] shadow-2xl overflow-hidden
        {mobile
          ? 'left-4 right-4 bottom-20 md:left-auto md:right-4 md:bottom-auto md:top-14 md:w-80'
          : 'right-4 top-14 w-80'}"
    >
      <div class="px-4 py-3 border-b border-cn-border flex items-center justify-between">
        <span class="text-sm font-semibold">Notifications</span>
        {#if notifications.some((n) => !n.read)}
          <span class="text-xs text-text-muted">Marqué comme lu</span>
        {/if}
      </div>

      {#if notifications.length === 0}
        <p class="px-4 py-6 text-sm text-text-muted text-center">Aucune notification</p>
      {:else}
        <ul class="max-h-96 overflow-y-auto divide-y divide-cn-border">
          {#each notifications as notif (notif.id)}
            <li>
              <button
                type="button"
                class="w-full text-left px-4 py-3 hover:bg-cn-surface transition-colors flex gap-3 items-start"
                onclick={() => openNotification(notif)}
              >
                <span class="mt-0.5 text-base shrink-0">
                  {#if notif.type === 'reaction'}
                    {notif.text || '❤️'}
                  {:else if notif.type === 'mention'}
                    🔔
                  {:else if notif.type === 'reply'}
                    ↩️
                  {:else if notif.type === 'form_reminder'}
                    ⏰
                  {:else}
                    💬
                  {/if}
                </span>
                <div class="min-w-0 flex-1">
                  <p class="text-sm leading-snug line-clamp-2">
                    {#if notif.type === 'reaction'}
                      {notif.actorName || "Quelqu'un"} a réagi à votre publication
                    {:else if notif.type === 'mention'}
                      {notif.actorName || "Quelqu'un"} vous a mentionné
                    {:else}
                      {notif.text}
                    {/if}
                  </p>
                  <p class="text-xs text-text-muted mt-0.5">{formatRelative(notif.createdAt)}</p>
                </div>
                {#if !notif.read}
                  <span class="mt-1.5 w-2 h-2 rounded-full bg-blue-500 shrink-0"></span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
