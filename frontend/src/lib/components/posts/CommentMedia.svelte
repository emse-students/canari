<script lang="ts">
  import PostMedia from './PostMedia.svelte';
  import { nearViewport } from '$lib/actions/nearViewport';
  import type { PostComment } from '$lib/posts/api';
  import { mediaAspectStyle, resolveMediaType, reservesAspectRatio } from '$lib/utils/mediaLayout';

  /**
   * THE PICTURE OF A COMMENT (a GIF, a sticker, a screenshot), drawn by the thread and by the card's
   * collapsed preview. `compact` is the preview's thumbnail: narrower, so a comment that is only a
   * picture stays a few lines tall in the feed.
   *
   * THE PREVIEW HOLDS ITS DOWNLOAD AND DECRYPTION UNTIL THE CARD COMES NEAR THE VIEWPORT
   * (`nearViewport`, as `PostContent` does for a post's own attachments): a feed mounts every card
   * it renders, and without the gate each one fetched and decrypted its latest comment's picture
   * at once, ahead of the page the reader is waiting for. The thread is already on screen, so it
   * is never deferred.
   */
  interface Props {
    media: NonNullable<PostComment['media']>;
    authToken: string;
    compact?: boolean;
  }

  let { media, authToken, compact = false }: Props = $props();

  let near = $state(false);

  const reserved = $derived(reservesAspectRatio(resolveMediaType(media)));
</script>

<div
  data-comment-media
  class="relative mt-1.5 w-full overflow-hidden rounded-xl {reserved
    ? `${compact ? 'max-w-32' : 'max-w-56'} bg-black/5 dark:bg-white/5`
    : compact
      ? 'max-w-40'
      : 'max-w-[20rem]'}"
  style={reserved ? mediaAspectStyle(media.width, media.height) : ''}
  use:nearViewport={{ onnear: () => (near = true) }}
>
  <PostMedia {media} {authToken} deferred={compact && !near} />
</div>
