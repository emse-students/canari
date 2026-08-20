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
    const url =
      notif.type === 'form_reminder' ? `/forms/${notif.postId}` : `/posts/${notif.postId}`;
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
    class="text-text-muted hover:text-text hover:bg-cn-surface relative flex h-9 w-9 items-center justify-center rounded-full transition-colors"
  >
    <Bell size={18} strokeWidth={2} />
    {#if postNotifStore.unread > 0}
      <span
        class="absolute -top-0.5 -right-0.5 flex h-[1.1rem] min-w-[1.1rem] items-center justify-center rounded-full bg-red-500 px-0.5 text-[0.6rem] font-bold text-white"
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
      class="border-cn-border bg-cn-surface fixed top-[calc(env(safe-area-inset-top,0px)+3.5rem)] right-4 z-[200] w-80 overflow-hidden rounded-xl border shadow-2xl"
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
        <ul class="divide-cn-border max-h-96 divide-y overflow-y-auto">
          {#each postNotifStore.notifications as notif (notif.id)}
            <li>
              <button
                type="button"
                class="hover:bg-cn-surface flex w-full items-start gap-3 px-4 py-3 text-left transition-colors"
                onclick={() => openNotification(notif)}
              >
                <span
                  class="bg-cn-surface text-text-muted mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                >
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
                  <p class="line-clamp-2 text-sm leading-snug">
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
                      <span>
                        {m.notif_comment_text()}
                        <span class="text-text-muted">{notif.text}</span></span
                      >
                    {/if}
                  </p>
                  <p class="text-text-muted mt-0.5 text-xs">{formatRelative(notif.createdAt)}</p>
                </div>
                {#if !notif.read}
                  <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-blue-500"></span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
