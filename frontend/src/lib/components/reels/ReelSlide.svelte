<script lang="ts">
  /**
   * One reel in the full-screen viewer (C7): its video filling the screen, and who published it with
   * the caption over the bottom of the picture.
   *
   * THE OVERLAY IS THE POST CARD'S, NOT A SECOND COPY (user, 2026-10-16): the publisher's picture,
   * name and link are `PostAuthorAvatar` / `postAuthorName` / `postAuthorHref`, the text is
   * `PostMarkdown` - so an association post shows the association, a hidden author links nowhere,
   * and the description renders as its card does. Two lines, then "Voir plus" unfolds it in place.
   *
   * ONLY THE CURRENT REEL MOUNTS A PLAYER. The video is `PostMedia`'s, in gallery mode - the same
   * download, stream (a segmented video plays as it arrives) and failure state as everywhere else,
   * with `VideoPlayer`, its bar and the app's one sound answer. A neighbour draws Canari's poster
   * instead, because every mounted player counts as an open viewer and claims playback
   * (`followVideoSound`); the NEXT reel preloads its video meanwhile (`ReelPreload`), so its player
   * takes the warm path and shows the first frame the moment the swipe lands.
   *
   * THE SAVE BUTTON (`ReelSaveButton`) is in the player's bar next to the volume button, for every
   * reel (user, 2026-10-09: "public or not"). Nothing here claims the video is protected.
   */
  import PostMedia from '$lib/components/posts/PostMedia.svelte';
  import VideoPoster from '$lib/components/shared/VideoPoster.svelte';
  import type { PostEntity } from '$lib/posts/api';
  import PostAuthorAvatar from '$lib/components/posts/PostAuthorAvatar.svelte';
  import PostMarkdown from '$lib/components/posts/PostMarkdown.svelte';
  import { postAuthorHref, postAuthorLinkLabel, postAuthorName } from '$lib/posts/postAuthorName';
  import { REEL_FRAME_RATIO } from '$lib/reels/reelFrame';
  import { ReelPreload } from '$lib/reels/reelPreload';
  import { watchClampOverflow } from '$lib/utils/posts/clampOverflow';
  import { exactDate, timeAgo } from '$lib/utils/time';
  import { m } from '$lib/paraglide/messages';
  import ReelFrame from './ReelFrame.svelte';
  import ReelSaveButton from './ReelSaveButton.svelte';

  interface Props {
    post: PostEntity;
    authToken: string;
    /** The reel on screen: it plays. */
    active: boolean;
    /** The reel after the current one: its video is fetched ahead. */
    preload: boolean;
  }

  let { post, authToken, active, preload }: Props = $props();

  const video = $derived((post.media ?? post.images ?? [])[0]);
  /** The reel's own shape when the publisher recorded it, else the canonical frame. */
  const ratio = $derived(
    video?.width && video?.height ? video.width / video.height : REEL_FRAME_RATIO
  );
  const authorName = $derived(postAuthorName(post));
  const authorHref = $derived(postAuthorHref(post));

  /** The caption unfolded in place ("Voir plus"); folded again when the reel leaves the screen. */
  let expanded = $state(false);
  let textEl = $state<HTMLDivElement | undefined>();
  /** Whether the folded text hides lines - measured, so a short caption shows no "Voir plus". */
  let overflows = $state(false);

  function setExpanded(next: boolean) {
    console.debug(`[reel-viewer] caption ${next ? 'expanded' : 'folded'} on ${post.id}`);
    expanded = next;
  }

  $effect(() => {
    if (!active && expanded) expanded = false;
  });

  $effect(() => {
    if (!textEl || expanded) return;
    return watchClampOverflow(textEl, (value) => (overflows = value));
  });

  $effect(() => {
    if (!preload || active || !video || !authToken) return;
    const ahead = new ReelPreload(video);
    return () => ahead.stop();
  });
</script>

<!-- THE SAVE IS IN THE PLAYER'S BAR, BESIDE THE VOLUME, FOR EVERY REEL (user, 2026-10-09): public or
     not, the member's own or anybody's. It saves what the viewer holds - the ref with its key that
     the player itself decrypts - so nothing here asks the server who owns the reel. -->
{#snippet barActions()}
  <ReelSaveButton reel={post} />
{/snippet}

<div class="relative h-full w-full overflow-hidden bg-black" data-reel-slide={post.id}>
  <!-- THE SAME FRAME AS THE CAMERA, THE REVIEW AND THE EDITOR: what is published is what was framed,
       in the reel's own shape (a legacy reel was captured to a screen box, a gallery import has its
       own). The caption is INSIDE the frame, above the player's bar, so the two never overlap. -->
  <ReelFrame {ratio}>
    <div class="flex h-full w-full items-center justify-center">
      {#if active && video}
        <PostMedia media={video} {authToken} galleryMode {barActions} />
      {:else}
        <VideoPoster />
      {/if}
    </div>

    {#if expanded}
      <!-- TAP OUTSIDE FOLDS THE TEXT. A button, so it is not a viewer gesture (`NOT_A_GESTURE`): a
           tap or a stray swipe on it neither pauses the video under it nor turns the reel. Out of
           the tab order - the "Voir moins" below is the keyboard's way. -->
      <button
        type="button"
        class="absolute inset-0 cursor-default"
        tabindex="-1"
        aria-label={m.post_voir_moins()}
        onclick={() => setExpanded(false)}
        data-reel-caption-backdrop
      ></button>
    {/if}

    <!-- WHO PUBLISHED IT, AND WHAT THEY WROTE, BOTTOM-LEFT OVER A SCRIM (user, 2026-10-16, as on
         Instagram). Anchored to the bottom, so a longer text or 2x type grows UPWARD, above the
         player's bar, never off-screen. Pointer-transparent except the author link and the text
         controls, so a tap anywhere else still reaches the video. -->
    <div
      class="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/80 via-black/50 to-transparent px-4 pt-16 pb-[calc(var(--safe-area-inset-bottom,0px)+4.5rem)] text-white"
      data-reel-caption
    >
      <div class="flex min-w-0 items-center gap-2">
        {#if authorHref}
          <a
            href={authorHref}
            class="pointer-events-auto flex min-w-0 items-center gap-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            aria-label={postAuthorLinkLabel(post)}
            data-reel-author
          >
            <span class="shrink-0"><PostAuthorAvatar {post} size="sm" /></span>
            <span class="truncate text-sm font-bold">{authorName}</span>
          </a>
        {:else}
          <span class="flex min-w-0 items-center gap-2" data-reel-author>
            <span class="shrink-0"><PostAuthorAvatar {post} size="sm" /></span>
            <span class="truncate text-sm font-bold">{authorName}</span>
          </span>
        {/if}
        <!-- The same age, from the same helper, as the post header's: the viewer has no header. -->
        <span class="shrink-0 text-xs font-medium opacity-70" title={exactDate(post.createdAt)}
          >{timeAgo(post.createdAt)}</span
        >
      </div>
      {#if post.markdown}
        <!-- EXPANDED, THE TEXT SCROLLS ITSELF, up to half the screen: `data-reel-caption-open` keeps
             the viewer's swipe off it, and `touch-pan-y` lets the engine scroll it. -->
        <div
          class="mt-1 {expanded
            ? 'pointer-events-auto max-h-[50dvh] touch-pan-y overflow-y-auto overscroll-contain'
            : ''}"
          data-reel-caption-open={expanded ? '' : undefined}
        >
          <PostMarkdown
            markdown={post.markdown}
            bind:element={textEl}
            class="text-sm leading-snug opacity-90 {expanded ? '' : 'line-clamp-2'}"
          />
        </div>
        {#if overflows || expanded}
          <button
            type="button"
            class="tap-target pointer-events-auto mt-1 text-xs font-bold outline-none hover:underline focus-visible:underline"
            aria-expanded={expanded}
            onclick={() => setExpanded(!expanded)}
            data-reel-caption-toggle
          >
            {expanded ? m.post_voir_moins() : m.post_voir_plus()}
          </button>
        {/if}
      {/if}
    </div>
  </ReelFrame>
</div>
