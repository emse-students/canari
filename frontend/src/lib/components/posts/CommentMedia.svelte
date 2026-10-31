<script lang="ts">
  import PostImage from './PostImage.svelte';
  import type { PostComment } from '$lib/posts/api';
  import { mediaAspectStyle, resolveMediaType, reservesAspectRatio } from '$lib/utils/mediaLayout';

  /**
   * THE PICTURE OF A COMMENT (a GIF, a sticker, a screenshot), drawn by the thread and by the card's
   * collapsed preview. `compact` is the preview's thumbnail: narrower, so a comment that is only a
   * picture stays a few lines tall in the feed.
   */
  interface Props {
    media: NonNullable<PostComment['media']>;
    authToken: string;
    compact?: boolean;
  }

  let { media, authToken, compact = false }: Props = $props();

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
>
  <PostImage {media} {authToken} />
</div>
