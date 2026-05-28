<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { AtSign, CornerDownLeft, MessageCircle, Clock, BellOff } from '@lucide/svelte';
  import { postNotifStore } from '$lib/stores/postNotifStore.svelte';
  import { reactionTypeToEmoji } from '$lib/posts/reactions';
  import { formatRelative } from '$lib/utils/time';
  import type { PostNotification } from '$lib/posts/api';

  onMount(() => {
    void postNotifStore.load(50);
    void postNotifStore.markAllRead();
  });

  function openNotification(notif: PostNotification) {
    const url =
      notif.type === 'form_reminder' ? `/forms/${notif.postId}` : `/posts/${notif.postId}`;
    void goto(url);
  }
</script>

<svelte:head>
  <title>Notifications - Canari</title>
</svelte:head>

<main class="max-w-xl mx-auto px-4 py-6 pb-24 md:pb-8">
  <h1 class="text-xl font-bold mb-5 text-text-main">Notifications</h1>

  {#if postNotifStore.loading && postNotifStore.notifications.length === 0}
    <div class="flex flex-col gap-3">
      {#each { length: 6 } as _, i (i)}
        <div class="flex gap-3 items-start animate-pulse">
          <div class="w-10 h-10 rounded-full bg-cn-surface shrink-0"></div>
          <div class="flex-1 space-y-2 py-1">
            <div class="h-3 bg-cn-surface rounded w-3/4"></div>
            <div class="h-2.5 bg-cn-surface rounded w-1/3"></div>
          </div>
        </div>
      {/each}
    </div>
  {:else if postNotifStore.notifications.length === 0}
    <div class="flex flex-col items-center gap-3 py-16 text-text-muted">
      <BellOff size={40} strokeWidth={1.5} class="opacity-40" />
      <p class="text-sm">Aucune notification pour l'instant</p>
    </div>
  {:else}
    <ul class="flex flex-col divide-y divide-cn-border">
      {#each postNotifStore.notifications as notif (notif.id)}
        <li>
          <button
            type="button"
            class="w-full text-left py-3.5 flex gap-3 items-start hover:bg-cn-surface/60 transition-colors rounded-xl px-2 -mx-2"
            onclick={() => openNotification(notif)}
          >
            <!-- Icône du type de notification -->
            <span
              class="shrink-0 mt-0.5 flex items-center justify-center w-10 h-10 rounded-full
                {notif.type === 'reaction' ? 'bg-pink-500/10 text-pink-500' : ''}
                {notif.type === 'mention'
                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : ''}
                {notif.type === 'reply' ? 'bg-blue-500/10 text-blue-500' : ''}
                {notif.type === 'comment' ? 'bg-green-500/10 text-green-600' : ''}
                {notif.type === 'form_reminder' ? 'bg-purple-500/10 text-purple-500' : ''}"
            >
              {#if notif.type === 'reaction'}
                <span class="text-lg leading-none">{reactionTypeToEmoji(notif.text)}</span>
              {:else if notif.type === 'mention'}
                <AtSign size={18} strokeWidth={2.5} />
              {:else if notif.type === 'reply'}
                <CornerDownLeft size={18} strokeWidth={2.5} />
              {:else if notif.type === 'form_reminder'}
                <Clock size={18} strokeWidth={2.5} />
              {:else}
                <MessageCircle size={18} strokeWidth={2.5} />
              {/if}
            </span>

            <!-- Contenu -->
            <div class="min-w-0 flex-1">
              <p class="text-sm leading-snug">
                <span class="font-semibold text-text-main">{notif.actorName || "Quelqu'un"}</span>
                {#if notif.type === 'reaction'}
                  <span class="text-text-muted"> a réagi à votre publication</span>
                {:else if notif.type === 'mention'}
                  <span class="text-text-muted"> vous a mentionné</span>
                {:else if notif.type === 'reply'}
                  <span class="text-text-muted"> a répondu à votre commentaire</span>
                {:else if notif.type === 'form_reminder'}
                  <span class="text-text-muted"> {notif.text}</span>
                {:else}
                  <span class="text-text-muted">
                    a commenté : <span class="italic">{notif.text}</span></span
                  >
                {/if}
              </p>
              <p class="text-xs text-text-muted mt-1">{formatRelative(notif.createdAt)}</p>
            </div>

            <!-- Point non-lu -->
            {#if !notif.read}
              <span class="mt-2 w-2.5 h-2.5 rounded-full bg-blue-500 shrink-0 shadow-sm"></span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</main>
