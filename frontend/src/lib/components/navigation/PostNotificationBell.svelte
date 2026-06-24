<script lang="ts">
  import { Bell, AtSign, CornerDownLeft, MessageCircle, Clock } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import { portal } from '$lib/actions/portal';
  import { goto } from '$app/navigation';
  import { formatRelative } from '$lib/utils/time';
  import { createPausableInterval } from '$lib/utils/backgroundPausableInterval';
  import { postNotifStore } from '$lib/stores/postNotifStore.svelte';
  import { reactionTypeToEmoji } from '$lib/posts/reactions';
  import type { PostNotification } from '$lib/posts/api';
  import { m } from '$lib/paraglide/messages';

  let open = $state(false);

  async function toggle() {
    open = !open;
    if (open) {
      await postNotifStore.markAllRead();
    }
  }

  function openNotification(notif: PostNotification) {
    open = false;
    const url = notif.type === 'form_reminder' ? `/forms/${notif.postId}` : `/posts/${notif.postId}`;
    void goto(url);
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
    title="Notifications"
    aria-label="Notifications"
    class="relative flex items-center justify-center w-9 h-9 rounded-full text-text-muted hover:text-text hover:bg-cn-surface transition-colors"
  >
    <Bell size={18} strokeWidth={2} />
    {#if postNotifStore.unread > 0}
      <span
        class="absolute -top-0.5 -right-0.5 min-w-[1.1rem] h-[1.1rem] flex items-center justify-center rounded-full bg-red-500 text-white text-[0.6rem] font-bold px-0.5"
      >
        {postNotifStore.unread > 9 ? '9+' : postNotifStore.unread}
      </span>
    {/if}
  </button>

  {#if open}
    <div
      use:portal
      role="presentation"
      class="fixed inset-0 z-[190]"
      onclick={() => (open = false)}
    ></div>

    <div
      use:portal
      class="fixed z-[200] right-4 top-[calc(env(safe-area-inset-top,0px)+3.5rem)] w-80 rounded-xl border border-cn-border bg-white dark:bg-[#0f1622] shadow-2xl overflow-hidden"
    >
      <div class="px-4 py-3 border-b border-cn-border flex items-center justify-between">
        <span class="text-sm font-semibold">{m.notif_bell_heading()}</span>
        {#if postNotifStore.notifications.some((n) => !n.read)}
          <span class="text-xs text-text-muted">{m.notif_bell_mark_read()}</span>
        {/if}
      </div>

      {#if postNotifStore.notifications.length === 0}
        <p class="px-4 py-6 text-sm text-text-muted text-center">{m.notif_bell_empty()}</p>
      {:else}
        <ul class="max-h-96 overflow-y-auto divide-y divide-cn-border">
          {#each postNotifStore.notifications as notif (notif.id)}
            <li>
              <button
                type="button"
                class="w-full text-left px-4 py-3 hover:bg-cn-surface transition-colors flex gap-3 items-start"
                onclick={() => openNotification(notif)}
              >
                <span class="mt-0.5 shrink-0 flex items-center justify-center w-7 h-7 rounded-full bg-cn-surface text-text-muted">
                  {#if notif.type === 'reaction'}
                    <span class="text-base leading-none">{reactionTypeToEmoji(notif.text)}</span>
                  {:else if notif.type === 'mention'}
                    <AtSign size={14} strokeWidth={2.5} />
                  {:else if notif.type === 'reply'}
                    <CornerDownLeft size={14} strokeWidth={2.5} />
                  {:else if notif.type === 'form_reminder'}
                    <Clock size={14} strokeWidth={2.5} />
                  {:else}
                    <MessageCircle size={14} strokeWidth={2.5} />
                  {/if}
                </span>
                <div class="min-w-0 flex-1">
                  <p class="text-sm leading-snug line-clamp-2">
                    <span class="font-semibold">{notif.actorName || m.notif_actor_unknown()}</span>
                    {#if notif.type === 'reaction'}
                      <span> {m.notif_reaction_text()}</span>
                    {:else if notif.type === 'mention'}
                      <span> {m.notif_mention_text()}</span>
                    {:else if notif.type === 'reply'}
                      <span> {m.notif_reply_text()}</span>
                    {:else if notif.type === 'form_reminder'}
                      <span> {notif.text}</span>
                    {:else}
                      <span> {m.notif_comment_text()} <span class="text-text-muted">{notif.text}</span></span>
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
