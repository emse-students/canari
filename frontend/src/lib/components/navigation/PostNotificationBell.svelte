<script lang="ts">
  import { Bell } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { getPostNotifications, markPostNotificationsRead } from '$lib/posts/api';
  import type { PostNotification } from '$lib/posts/api';

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

  function formatRelative(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'à l\'instant';
    if (m < 60) return `il y a ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `il y a ${h}h`;
    return `il y a ${Math.floor(h / 24)}j`;
  }

  function openPost(postId: string) {
    open = false;
    void goto(`/posts/${postId}`);
  }

  onMount(() => {
    void load();
    const interval = setInterval(() => void load(), 60000);
    return () => clearInterval(interval);
  });
</script>

<div class="relative">
  <button
    type="button"
    onclick={toggle}
    title="Notifications"
    aria-label="Notifications"
    class="relative flex items-center justify-center w-9 h-9 rounded-full text-text-muted hover:text-text hover:bg-cn-surface transition-colors"
  >
    <Bell size={18} />
    {#if unread > 0}
      <span
        class="absolute -top-0.5 -right-0.5 min-w-[1.1rem] h-[1.1rem] flex items-center justify-center rounded-full bg-red-500 text-white text-[0.6rem] font-bold px-0.5"
      >
        {unread > 9 ? '9+' : unread}
      </span>
    {/if}
  </button>

  {#if open}
    <!-- backdrop -->
    <div
      role="presentation"
      class="fixed inset-0 z-30"
      onclick={() => (open = false)}
    ></div>

    <div
      class="absolute right-0 top-11 z-40 w-80 rounded-xl border border-cn-border bg-surface-elevated shadow-xl overflow-hidden"
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
                onclick={() => openPost(notif.postId)}
              >
                <span class="mt-0.5 text-base shrink-0">
                  {notif.type === 'reply' ? '↩️' : '💬'}
                </span>
                <div class="min-w-0 flex-1">
                  <p class="text-sm leading-snug line-clamp-2">{notif.text}</p>
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
