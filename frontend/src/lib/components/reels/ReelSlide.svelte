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
   */
  import PostMedia from '$lib/components/posts/PostMedia.svelte';
  import VideoPoster from '$lib/components/shared/VideoPoster.svelte';
  import type { PostEntity } from '$lib/posts/api';
  import { postAuthorName } from '$lib/posts/postAuthorName';
  import { ReelPreload } from '$lib/reels/reelPreload';
  import { markdownToPlainText } from '$lib/seo/text';
  import { myReels } from '$lib/reels/myReels.svelte';
  import ReelExpiryChip from './ReelExpiryChip.svelte';
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

  /** The member's own reel, with its expiry and its key - `undefined` for anybody else's. */
  const mine = $derived(myReels.find(post.id));
  $effect(() => {
    if (active) myReels.ensure(post);
  });

  $effect(() => {
    if (!preload || active || !video || !authToken) return;
    const ahead = new ReelPreload(video);
    return () => ahead.stop();
  });
</script>

<div class="relative h-full w-full overflow-hidden bg-black" data-reel-slide={post.id}>
  <div class="flex h-full w-full items-center justify-center">
    {#if active && video}
      <PostMedia media={video} {authToken} galleryMode />
    {:else}
      <VideoPoster />
    {/if}
  </div>

  <div
    class="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/70 to-transparent px-4 pt-16 pb-[calc(var(--safe-area-inset-bottom,0px)+4.5rem)] text-white"
  >
    {#if mine}
      <div class="mb-2"><ReelExpiryChip reel={mine} /></div>
    {/if}
    <p class="text-sm font-bold">{postAuthorName(post)}</p>
    {#if caption}
      <p class="mt-1 line-clamp-3 text-sm leading-snug opacity-90">{caption}</p>
    {/if}
  </div>

  {#if mine && active}
    <!-- The author's save, right of the caption where Instagram puts a reel's actions. -->
    <div class="absolute right-3 bottom-[calc(var(--safe-area-inset-bottom,0px)+5rem)]">
      <ReelSaveButton reel={mine} />
    </div>
  {/if}
</div>
