<script lang="ts">
  /**
   * One reel in the full-screen viewer (C7): its video filling the screen, and who published it with
   * the caption over the bottom of the picture.
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
  import { postAuthorName } from '$lib/posts/postAuthorName';
  import { ReelPreload } from '$lib/reels/reelPreload';
  import { markdownToPlainText } from '$lib/seo/text';
  import { exactDate, timeAgo } from '$lib/utils/time';
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
  const caption = $derived(markdownToPlainText(post.markdown ?? ''));

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
  <div class="flex h-full w-full items-center justify-center">
    {#if active && video}
      <PostMedia media={video} {authToken} galleryMode {barActions} />
    {:else}
      <VideoPoster />
    {/if}
  </div>

  <div
    class="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/70 to-transparent px-4 pt-16 pb-[calc(var(--safe-area-inset-bottom,0px)+4.5rem)] text-white"
  >
    <p class="text-sm font-bold">
      {postAuthorName(post)}
      <!-- The same age, from the same helper, as the post header's: the viewer has no header. -->
      <span class="ml-1.5 text-xs font-medium opacity-70" title={exactDate(post.createdAt)}
        >{timeAgo(post.createdAt)}</span
      >
    </p>
    {#if caption}
      <p class="mt-1 line-clamp-3 text-sm leading-snug opacity-90">{caption}</p>
    {/if}
  </div>
</div>
