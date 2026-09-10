<script lang="ts">
  import {
    Image as ImageIcon,
    ImageOff,
    Link as LinkIcon,
    FileText,
    Download,
  } from '@lucide/svelte';
  import { MediaService } from '$lib/media';
  import { releaseDecryptedMediaBlobUrl } from '$lib/utils/mediaBlobCache';
  import { isMediaPurgedError } from '$lib/utils/mediaErrors';
  import { showToast } from '$lib/stores/toast.svelte';
  import { openExternal } from '$lib/utils/openExternal';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import MediaLightbox from '../shared/MediaLightbox.svelte';
  import SharedMediaThumb from './SharedMediaThumb.svelte';
  import type { SharedContent } from '$lib/utils/chat/sharedContent';
  import { downloadDecryptedFile } from '$lib/utils/fileDownload';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import { formatFileSize } from '$lib/utils/fileSize';

  interface Props {
    /** Conversation whose shared content is displayed (groupId or channel_<id>). */
    conversationId: string;
    /** Non-empty once the session is authenticated; the download resolves its own live token. */
    authToken: string;
    /** Loads the full aggregated shared content from the local message history. */
    loadSharedContent: (conversationId: string) => Promise<SharedContent>;
  }

  let { conversationId, authToken, loadSharedContent }: Props = $props();

  type Tab = 'media' | 'links' | 'files';
  let activeTab = $state<Tab>('media');
  let loading = $state(false);
  let content = $state<SharedContent>({ media: [], files: [], links: [] });
  /** Number of media thumbnails currently mounted (bounds concurrent decryptions). */
  let mediaWindow = $state(60);

  /** Index into content.media of the open lightbox, or null when closed. */
  let lightboxIndex = $state<number | null>(null);
  let lightboxUrl = $state<string | null>(null);
  /**
   * Why the open item has no image. Without it the lightbox spins forever on a media the
   * server will never return - a purged blob has no retry that can succeed.
   */
  let lightboxError = $state('');

  const dateFmt = $derived(
    new Intl.DateTimeFormat(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
      day: '2-digit',
      month: 'short',
      year: '2-digit',
    })
  );

  function senderName(userId: string): string {
    return getUserDisplayNameSync(userId);
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).host.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  /*
   * (Re)load whenever the conversation changes.
   *
   * The `open` guard that used to be here is gone WITH the prop: the panel is now mounted only
   * while it is showing, so "open" is no longer a state this component can be in and false for -
   * it is the difference between existing and not.
   */
  $effect(() => {
    if (!conversationId) return;
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
      lightboxError = '';
      return;
    }
    const item = content.media[idx];
    if (!item || !authToken) return;
    const ref = item.media;
    let destroyed = false;
    let acquired = false;
    lightboxUrl = null;
    lightboxError = '';
    new MediaService()
      .downloadAndDecrypt(ref)
      .then((url) => {
        if (destroyed) releaseDecryptedMediaBlobUrl(ref);
        else {
          lightboxUrl = url;
          acquired = true;
        }
      })
      .catch((err) => {
        if (destroyed) return;
        if (isMediaPurgedError(err)) {
          lightboxError = m.msg_media_expired_label();
        } else {
          console.error('[ConversationMediaPanel] media decrypt failed', err);
          lightboxError = m.msg_image_load_error();
        }
      });
    return () => {
      destroyed = true;
      if (acquired) releaseDecryptedMediaBlobUrl(ref);
    };
  });

  async function downloadFile(ref: (typeof content.files)[number]['media']) {
    try {
      const url = await new MediaService().downloadAndDecrypt(ref);
      await downloadDecryptedFile(url, ref.fileName ?? 'fichier');
    } catch (err) {
      // A console line is a trace for us, not an answer for the user: pressing a download
      // button and getting nothing at all is the same silent gap as a missing image.
      console.error('[ConversationMediaPanel] download failed', err);
      showToast(isMediaPurgedError(err) ? m.msg_media_expired_label() : m.msg_image_load_error());
    }
  }

  function openLink(url: string) {
    void openExternal(url);
  }

  const tabs: { id: Tab; label: string; count: number }[] = $derived([
    { id: 'media', label: m.chat_media_tab(), count: content.media.length },
    { id: 'links', label: m.chat_links_tab(), count: content.links.length },
    { id: 'files', label: m.chat_files_tab(), count: content.files.length },
  ]);
</script>

<!--
  CONTENT ONLY, and the scrim it used to draw is the reason this file changed. It portalled itself
  to `fixed inset-0` with a black overlay on EVERY viewport, so on a desktop with room for a third
  column it covered the conversation it was describing. `ConversationSidePanel` owns the shell, the
  header and the close button now; the search action is handed up to it as a header control.
-->
<div class="flex h-full min-h-0 flex-col">
  <!-- Tabs -->
  <div class="border-cn-border flex gap-1 border-b px-2 py-2">
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
          class="border-cn-yellow h-7 w-7 animate-spin rounded-full border-4 border-t-transparent"
        ></div>
      </div>
    {:else if activeTab === 'media'}
      {#if content.media.length === 0}
        <p class="text-text-muted py-12 text-center text-sm">{m.chat_no_shared_media()}</p>
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
            class="border-cn-border text-text-muted mt-3 w-full rounded-xl border py-2 text-sm font-semibold hover:bg-black/5 dark:hover:bg-white/10"
          >
            {m.chat_see_more_media_button({ content: content.media.length - mediaWindow })}
          </button>
        {/if}
      {/if}
    {:else if activeTab === 'links'}
      {#if content.links.length === 0}
        <p class="text-text-muted py-12 text-center text-sm">{m.chat_no_shared_links()}</p>
      {:else}
        <div class="flex flex-col gap-1">
          {#each content.links as link (link.messageId + link.url)}
            <button
              type="button"
              onclick={() => openLink(link.url)}
              class="flex flex-col items-start gap-0.5 rounded-xl px-3 py-2 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/10"
            >
              <span class="w-full truncate text-sm font-semibold text-amber-600 dark:text-amber-400"
                >{hostOf(link.url)}</span
              >
              <span class="text-text-muted w-full truncate text-xs">{link.url}</span>
              <span class="text-text-muted/80 text-2xs"
                >{senderName(link.senderId)} · {dateFmt.format(link.timestamp)}</span
              >
            </button>
          {/each}
        </div>
      {/if}
    {:else if content.files.length === 0}
      <p class="text-text-muted py-12 text-center text-sm">{m.chat_no_shared_files()}</p>
    {:else}
      <div class="flex flex-col gap-1">
        {#each content.files as file (file.messageId + file.media.mediaId)}
          <button
            type="button"
            onclick={() => downloadFile(file.media)}
            class="flex items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/10"
          >
            <span
              class="bg-cn-yellow/15 text-cn-ink flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            >
              <FileText size={18} />
            </span>
            <span class="min-w-0 flex-1">
              <span class="text-text-main block truncate text-sm font-medium"
                >{file.media.fileName ?? m.chat_file_label()}</span
              >
              <span class="text-text-muted block text-xs"
                >{formatFileSize(file.media.size)} · {senderName(file.senderId)} · {dateFmt.format(
                  file.timestamp
                )}</span
              >
            </span>
            <Download size={16} class="text-text-muted shrink-0" />
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

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
    {:else if lightboxError}
      <div class="flex flex-col items-center gap-3 p-6 text-center text-white/70">
        <ImageOff size={32} strokeWidth={1.5} />
        <span class="text-sm">{lightboxError}</span>
      </div>
    {:else}
      <div
        class="h-10 w-10 animate-spin rounded-full border-4 border-white/70 border-t-transparent"
      ></div>
    {/if}
  </MediaLightbox>
{/if}
