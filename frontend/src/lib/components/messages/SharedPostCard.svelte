<script lang="ts">
  import { EyeOff } from '@lucide/svelte';
  import PostAuthorAvatar from '$lib/components/posts/PostAuthorAvatar.svelte';
  import VideoPlayDisc from '$lib/components/ui/player/VideoPlayDisc.svelte';
  import { nearViewport } from '$lib/actions/nearViewport';
  import { getToken } from '$lib/stores/auth';
  import { currentUserId } from '$lib/stores/user';
  import { navigateInAppFromHref } from '$lib/utils/appLinkNavigation';
  import { inAppPathFromHref } from '$lib/utils/publicAppUrl';
  import { parseCanariLinkTarget } from '$lib/utils/canariLinkPreviewFormat';
  import { placeholderDataUrl } from '$lib/utils/mediaPlaceholder';
  import type { MediaFailureCause } from '$lib/utils/mediaErrors';
  import { Log } from '$lib/utils/Log';
  import {
    cachedSharedPostPreview,
    fetchSharedPostPreview,
    type SharedPostPreview,
    type SharedPostReady,
  } from '$lib/posts/sharedPostPreview';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE BUBBLE OF A POST OR A CANAREEL SENT INTO A CONVERSATION OR A CHANNEL (owner, 2026-11-09:
   * "comme Instagram"): the author's avatar and name, the post's first picture - or, for a video,
   * its ThumbHash and the glass play disc - the caption on three lines at most. A reel is the tall
   * 9:16 card of Instagram's reel share, and its tap opens the reels viewer; any other post opens
   * its page.
   *
   * The message is still a bare link: an older app draws its generic card from the same bytes.
   * The post is read with THIS reader's session once the card is within the viewport band
   * (`nearViewport`), so a long thread of shares fires one request per row that is actually near,
   * and `sharedPostPreview` caches the answer. A post the reader may not see - or one whose reel
   * file has expired (`410`) - draws "Publication indisponible" and nothing of its content.
   * See `docs/wiki/frontend/sharing.md`, "The shared-post bubble".
   */
  interface Props {
    /** The in-app link of the post (`/posts/<id>`). */
    url: string;
    /** True when the card is the only element in the bubble (drops the top margin). */
    standalone?: boolean;
  }

  let { url, standalone = false }: Props = $props();

  const postId = $derived.by(() => {
    const target = parseCanariLinkTarget(url);
    return target?.kind === 'post' ? target.postId : null;
  });
  const href = $derived(inAppPathFromHref(url) ?? '#');

  let preview = $state<SharedPostPreview | null>(null);
  /** Whether the file behind the preview is gone (an expired reel): the card turns unavailable. */
  let mediaGone = $state(false);
  /** Whether the picture failed for another reason: the card drops the picture and keeps the text. */
  let mediaFailed = $state(false);
  let isNear = $state(false);
  let authToken = $state('');
  let PostMedia = $state<typeof import('$lib/components/posts/PostMedia.svelte').default | null>(
    null
  );

  $effect(() => {
    const id = postId;
    mediaGone = false;
    mediaFailed = false;
    if (!id) {
      preview = { state: 'unavailable' };
      return;
    }
    const cached = cachedSharedPostPreview(id);
    if (cached) {
      preview = cached;
      return;
    }
    preview = null;
    if (!isNear) return;
    let cancelled = false;
    void fetchSharedPostPreview(id).then((answer) => {
      if (!cancelled) preview = answer;
    });
    return () => {
      cancelled = true;
    };
  });

  const ready = $derived<SharedPostReady | null>(preview?.state === 'ready' ? preview : null);
  const unavailable = $derived(preview?.state === 'unavailable' || (ready !== null && mediaGone));

  // The picture is decrypted by the post's own media path (`PostMedia`, the client-side CEK),
  // loaded on demand: a text-only or video card never pays for it.
  $effect(() => {
    if (ready?.mediaKind !== 'image' || PostMedia) return;
    let cancelled = false;
    void Promise.all([getToken(), import('$lib/components/posts/PostMedia.svelte')])
      .then(([token, mod]) => {
        if (cancelled) return;
        authToken = token;
        PostMedia = mod.default;
      })
      .catch((error: unknown) => {
        Log.d('SHARED_POST', `the picture component did not load: ${String(error)}`);
        mediaFailed = true;
      });
    return () => {
      cancelled = true;
    };
  });

  function onMediaFailure(cause: MediaFailureCause) {
    Log.d('SHARED_POST', `the media of ${postId?.slice(0, 8)} failed to load: ${cause}`);
    if (cause === 'expired') mediaGone = true;
    else mediaFailed = true;
  }

  const thumbHash = $derived(
    ready?.media?.placeholder ? placeholderDataUrl(ready.media.placeholder) : null
  );
  const showsMedia = $derived(ready !== null && ready.media !== null && !mediaFailed);
  const openLabel = $derived(
    ready
      ? ready.isReel
        ? m.shared_post_open_reel_label({ author: ready.authorName })
        : m.shared_post_open_label({ author: ready.authorName })
      : undefined
  );

  // The reels viewer, loaded on the tap like `LinkPreviewCard` does: most cards are no reel.
  let ReelViewer = $state<typeof import('$lib/components/reels/ReelViewer.svelte').default | null>(
    null
  );
  let viewerToken = $state('');
  let openReel = $state<NonNullable<SharedPostReady['reelPost']> | null>(null);

  async function openReelViewer(reel: NonNullable<SharedPostReady['reelPost']>) {
    Log.d('SHARED_POST', `opening the shared reel ${reel.id.slice(0, 8)} in the viewer`);
    try {
      const [token, mod] = await Promise.all([
        getToken(),
        import('$lib/components/reels/ReelViewer.svelte'),
      ]);
      viewerToken = token;
      ReelViewer = mod.default;
      openReel = reel;
    } catch (error) {
      console.error('[SHARED_POST] the reels viewer did not open', error);
    }
  }

  async function handleClick(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (ready?.reelPost) {
      await openReelViewer(ready.reelPost);
      return;
    }
    await navigateInAppFromHref(url);
  }
</script>

{#if unavailable}
  <div
    use:nearViewport={{ onnear: () => (isNear = true) }}
    class="bg-cn-surface text-text-muted flex w-64 max-w-full items-center gap-3 rounded-2xl border border-black/5 p-3 dark:border-white/10 {standalone
      ? ''
      : 'mt-3'}"
    role="note"
    data-shared-post="unavailable"
  >
    <EyeOff size={22} strokeWidth={2} class="shrink-0 opacity-60" aria-hidden="true" />
    <div class="min-w-0">
      <p class="text-text-main text-sm font-semibold">{m.shared_post_unavailable_title()}</p>
      <p class="text-xs leading-snug">{m.shared_post_unavailable_hint()}</p>
    </div>
  </div>
{:else}
  <a
    use:nearViewport={{ onnear: () => (isNear = true) }}
    onclick={handleClick}
    {href}
    aria-label={openLabel}
    aria-busy={ready ? undefined : 'true'}
    data-shared-post={ready ? (ready.isReel ? 'reel' : 'post') : 'loading'}
    class="bg-cn-surface flex max-w-full flex-col overflow-hidden rounded-2xl border border-black/5 dark:border-white/10 {ready?.isReel
      ? 'w-56'
      : 'w-64'} {standalone ? '' : 'mt-3'}"
  >
    <div class="flex items-center gap-2 px-3 py-2">
      {#if ready}
        <span class="h-7 w-7 shrink-0 overflow-hidden rounded-full">
          <PostAuthorAvatar post={ready.post} fill />
        </span>
        <span class="text-text-main min-w-0 flex-1 truncate text-sm font-semibold"
          >{ready.authorName}</span
        >
        {#if ready.isReel}
          <span
            class="text-2xs bg-cn-yellow/20 text-text-main shrink-0 rounded-full px-2 py-0.5 font-bold"
            >{m.shared_post_reel_chip()}</span
          >
        {/if}
      {:else}
        <div class="h-7 w-7 shrink-0 animate-pulse rounded-full bg-black/10 dark:bg-white/10"></div>
        <div
          class="h-3 w-24 animate-pulse rounded bg-black/10 dark:bg-white/10"
          data-shared-post-skeleton
        ></div>
      {/if}
    </div>

    {#if ready}
      {#if showsMedia && ready.media}
        <div
          class="relative w-full overflow-hidden bg-black/5 dark:bg-white/5"
          style="aspect-ratio: {ready.aspect}; {thumbHash
            ? `background: center / cover no-repeat url('${thumbHash}')`
            : ''}"
          data-shared-post-media={ready.mediaKind}
        >
          {#if ready.mediaKind === 'image'}
            {#if PostMedia && authToken}
              <!-- Inert: the whole card is the one link, so the picture's own lightbox button must
                   neither take focus nor a tap. -->
              <div class="absolute inset-0" inert>
                <PostMedia media={ready.media} {authToken} onFailure={onMediaFailure} />
              </div>
            {/if}
          {:else}
            {#if !thumbHash}
              <div
                class="from-cn-ink to-cn-scrim absolute inset-0 bg-linear-to-br"
                aria-hidden="true"
              ></div>
            {/if}
            <VideoPlayDisc />
          {/if}
        </div>
      {/if}
      {#if ready.caption}
        <!-- The padding is on the wrapper: a clamped box with its own padding shows the top of the
             fourth line in it. -->
        <div class="px-3 py-2">
          <p class="text-text-main line-clamp-3 text-sm leading-snug wrap-anywhere">
            {ready.caption}
          </p>
        </div>
      {:else if !showsMedia}
        <p class="text-text-muted px-3 py-2 text-sm italic">{m.shared_post_no_text()}</p>
      {/if}
    {:else}
      <div class="aspect-square w-full animate-pulse bg-black/6 dark:bg-white/8"></div>
      <div class="px-3 py-2">
        <div class="h-3 w-4/5 animate-pulse rounded bg-black/6 dark:bg-white/8"></div>
      </div>
    {/if}
  </a>
{/if}

{#if ReelViewer && openReel}
  <ReelViewer
    startPost={openReel}
    authToken={viewerToken}
    likerId={currentUserId() ?? undefined}
    onClose={() => (openReel = null)}
  />
{/if}
