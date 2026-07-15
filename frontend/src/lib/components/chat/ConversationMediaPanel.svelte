<script lang="ts">
  import {
    X,
    Search,
    Image as ImageIcon,
    Link as LinkIcon,
    FileText,
    Download,
  } from '@lucide/svelte';
  import { fade, fly } from 'svelte/transition';
  import { MediaService } from '$lib/media';
  import { releaseDecryptedMediaBlobUrl } from '$lib/utils/mediaBlobCache';
  import { openExternal } from '$lib/utils/openExternal';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import MediaLightbox from '../shared/MediaLightbox.svelte';
  import SharedMediaThumb from './SharedMediaThumb.svelte';
  import type { SharedContent } from '$lib/utils/chat/sharedContent';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  interface Props {
    open: boolean;
    /** Conversation whose shared content is displayed (groupId or channel_<id>). */
    conversationId: string;
    /** Bearer token forwarded to MediaService for decryption. */
    authToken: string;
    onClose: () => void;
    /** Loads the full aggregated shared content from the local message history. */
    loadSharedContent: (conversationId: string) => Promise<SharedContent>;
    /** Opens the in-conversation message search (panel closes first). */
    onOpenSearch?: () => void;
  }

  let { open, conversationId, authToken, onClose, loadSharedContent, onOpenSearch }: Props =
    $props();

  type Tab = 'media' | 'links' | 'files';
  let activeTab = $state<Tab>('media');
  let loading = $state(false);
  let content = $state<SharedContent>({ media: [], files: [], links: [] });
  /** Number of media thumbnails currently mounted (bounds concurrent decryptions). */
  let mediaWindow = $state(60);

  /** Index into content.media of the open lightbox, or null when closed. */
  let lightboxIndex = $state<number | null>(null);
  let lightboxUrl = $state<string | null>(null);

  const dateFmt = $derived(
    new Intl.DateTimeFormat(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
      day: '2-digit',
      month: 'short',
      year: '2-digit',
    })
  );

  function formatBytes(bytes: number): string {
    const locale = getLocale();
    const baseUnit = locale === 'en' ? 'B' : 'o';
    const units = locale === 'en' ? ['KB', 'MB', 'GB'] : ['Ko', 'Mo', 'Go'];
    if (!bytes || bytes < 1024) return `${bytes || 0} ${baseUnit}`;
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
  }

  function senderName(userId: string): string {
    return getUserDisplayNameSync(userId, userId);
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).host.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  // (Re)load whenever the panel opens or the conversation changes.
  $effect(() => {
    if (!open || !conversationId) return;
    const id = conversationId;
    loading = true;
    mediaWindow = 60;
    activeTab = 'media';
    loadSharedContent(id)
      .then((c) => {
        if (conversationId === id) content = c;
      })
      .catch(() => {
        if (conversationId === id) content = { media: [], files: [], links: [] };
      })
      .finally(() => {
        if (conversationId === id) loading = false;
      });
  });

  // Decrypt the selected media for the lightbox.
  $effect(() => {
    const idx = lightboxIndex;
    if (idx === null) {
      lightboxUrl = null;
      return;
    }
    const item = content.media[idx];
    if (!item || !authToken) return;
    const ref = item.media;
    let destroyed = false;
    let acquired = false;
    lightboxUrl = null;
    new MediaService()
      .downloadAndDecrypt(ref, authToken)
      .then((url) => {
        if (destroyed) releaseDecryptedMediaBlobUrl(ref);
        else {
          lightboxUrl = url;
          acquired = true;
        }
      })
      .catch(() => {});
    return () => {
      destroyed = true;
      if (acquired) releaseDecryptedMediaBlobUrl(ref);
    };
  });

  async function downloadFile(ref: (typeof content.files)[number]['media']) {
    try {
      const url = await new MediaService().downloadAndDecrypt(ref, authToken);
      const a = document.createElement('a');
      a.href = url;
      a.download = ref.fileName ?? 'fichier';
      a.click();
    } catch {
      // best-effort
    }
  }

  function openLink(url: string) {
    void openExternal(url);
  }

  function triggerSearch() {
    onClose();
    onOpenSearch?.();
  }

  const tabs: { id: Tab; label: string; count: number }[] = $derived([
    { id: 'media', label: m.chat_media_tab(), count: content.media.length },
    { id: 'links', label: m.chat_links_tab(), count: content.links.length },
    { id: 'files', label: m.chat_files_tab(), count: content.files.length },
  ]);
</script>

{#if open}
  <div class="fixed inset-0 z-[120] flex justify-end">
    <button
      type="button"
      class="absolute inset-0 bg-black/40 backdrop-blur-sm"
      aria-label={m.chat_panel_close_label()}
      onclick={onClose}
      transition:fade={{ duration: 180 }}
    ></button>

    <aside
      class="relative flex h-full w-full max-w-md flex-col bg-[var(--cn-surface)] shadow-2xl"
      transition:fly={{ x: 320, duration: 220 }}
    >
      <!-- Header -->
      <div class="flex items-center justify-between gap-2 border-b border-cn-border px-4 py-3">
        <h2 class="text-base font-bold text-text-main">{m.chat_media_links_files_title()}</h2>
        <div class="flex items-center gap-1">
          {#if onOpenSearch}
            <button
              type="button"
              onclick={triggerSearch}
              class="rounded-xl p-2 text-text-muted hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main transition-colors"
              title={m.chat_search_in_conversation_title()}
              aria-label={m.chat_search_in_conversation_label()}
            >
              <Search size={18} />
            </button>
          {/if}
          <button
            type="button"
            onclick={onClose}
            class="rounded-xl p-2 text-text-muted hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main transition-colors"
            aria-label={m.common_close_label()}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <!-- Tabs -->
      <div class="flex gap-1 border-b border-cn-border px-2 py-2">
        {#each tabs as tab (tab.id)}
          <button
            type="button"
            onclick={() => (activeTab = tab.id)}
            class="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-semibold transition-colors {activeTab ===
            tab.id
              ? 'bg-cn-yellow text-cn-ink'
              : 'text-text-muted hover:bg-black/5 dark:hover:bg-white/10'}"
          >
            {#if tab.id === 'media'}<ImageIcon size={15} />{:else if tab.id === 'links'}<LinkIcon
                size={15}
              />{:else}<FileText size={15} />{/if}
            {tab.label}
            {#if tab.count > 0}<span class="text-xs opacity-70">{tab.count}</span>{/if}
          </button>
        {/each}
      </div>

      <!-- Content -->
      <div class="min-h-0 flex-1 overflow-y-auto p-3">
        {#if loading}
          <div class="flex justify-center py-16">
            <div
              class="h-7 w-7 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
            ></div>
          </div>
        {:else if activeTab === 'media'}
          {#if content.media.length === 0}
            <p class="py-12 text-center text-sm text-text-muted">{m.chat_no_shared_media()}</p>
          {:else}
            <div class="grid grid-cols-3 gap-1.5">
              {#each content.media.slice(0, mediaWindow) as item (item.messageId + item.media.mediaId)}
                <SharedMediaThumb
                  media={item.media}
                  {authToken}
                  onClick={() => (lightboxIndex = content.media.indexOf(item))}
                />
              {/each}
            </div>
            {#if content.media.length > mediaWindow}
              <button
                type="button"
                onclick={() => (mediaWindow += 60)}
                class="mt-3 w-full rounded-xl border border-cn-border py-2 text-sm font-semibold text-text-muted hover:bg-black/5 dark:hover:bg-white/10"
              >
                {m.chat_see_more_media_button({ content: content.media.length - mediaWindow })}
              </button>
            {/if}
          {/if}
        {:else if activeTab === 'links'}
          {#if content.links.length === 0}
            <p class="py-12 text-center text-sm text-text-muted">{m.chat_no_shared_links()}</p>
          {:else}
            <div class="flex flex-col gap-1">
              {#each content.links as link (link.messageId + link.url)}
                <button
                  type="button"
                  onclick={() => openLink(link.url)}
                  class="flex flex-col items-start gap-0.5 rounded-xl px-3 py-2 text-left hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                >
                  <span
                    class="truncate text-sm font-semibold text-amber-600 dark:text-amber-400 w-full"
                    >{hostOf(link.url)}</span
                  >
                  <span class="truncate text-xs text-text-muted w-full">{link.url}</span>
                  <span class="text-[0.7rem] text-text-muted/80"
                    >{senderName(link.senderId)} · {dateFmt.format(link.timestamp)}</span
                  >
                </button>
              {/each}
            </div>
          {/if}
        {:else if content.files.length === 0}
          <p class="py-12 text-center text-sm text-text-muted">{m.chat_no_shared_files()}</p>
        {:else}
          <div class="flex flex-col gap-1">
            {#each content.files as file (file.messageId + file.media.mediaId)}
              <button
                type="button"
                onclick={() => downloadFile(file.media)}
                class="flex items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
              >
                <span
                  class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cn-yellow/15 text-cn-ink"
                >
                  <FileText size={18} />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-medium text-text-main"
                    >{file.media.fileName ?? m.chat_file_label()}</span
                  >
                  <span class="block text-xs text-text-muted"
                    >{formatBytes(file.media.size)} · {senderName(file.senderId)} · {dateFmt.format(
                      file.timestamp
                    )}</span
                  >
                </span>
                <Download size={16} class="shrink-0 text-text-muted" />
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </aside>
  </div>
{/if}

{#if lightboxIndex !== null && content.media[lightboxIndex]}
  {@const current = content.media[lightboxIndex]}
  <MediaLightbox
    open={true}
    onClose={() => (lightboxIndex = null)}
    title={current.media.fileName ?? current.caption ?? ''}
    showPrev={lightboxIndex > 0}
    showNext={lightboxIndex < content.media.length - 1}
    onPrev={() => (lightboxIndex = (lightboxIndex ?? 1) - 1)}
    onNext={() => (lightboxIndex = (lightboxIndex ?? 0) + 1)}
    dotCount={0}
  >
    {#if lightboxUrl}
      {#if current.media.type === 'video'}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={lightboxUrl} controls autoplay class="max-h-full max-w-full"></video>
      {:else}
        <img
          src={lightboxUrl}
          alt={current.media.fileName ?? m.conversation_media_fallback_alt()}
          class="max-h-full max-w-full object-contain select-none"
        />
      {/if}
    {:else}
      <div
        class="h-10 w-10 animate-spin rounded-full border-4 border-white/70 border-t-transparent"
      ></div>
    {/if}
  </MediaLightbox>
{/if}
