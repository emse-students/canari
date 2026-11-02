<script lang="ts">
  import type { PostEntity } from '$lib/posts/api';
  /**
   * Stands in for `ReelViewer` in the chat tests: what it was handed, and whether it would ask the
   * server for more reels (a conversation's reels are not the feed's).
   */
  let {
    startPost,
    loadPage,
    onMediaGone,
  }: {
    startPost: PostEntity;
    loadPage?: (o: number, l: number) => Promise<PostEntity[]>;
    onMediaGone?: (postId: string) => void;
  } = $props();
  let more = $state('pending');
  $effect(() => {
    void (loadPage ? loadPage(0, 10) : Promise.resolve([{}])).then((p) => {
      more = p.length === 0 ? 'none' : 'some';
    });
  });
</script>

<div
  data-reel-viewer-stub
  data-post-id={startPost.id}
  data-media-key={startPost.media[0]?.key}
  data-caption={startPost.markdown}
  data-has-more={more}
>
  <!-- What the real viewer does when its player meets the 410: tells the opener. -->
  {#if onMediaGone}
    <button
      type="button"
      aria-label="410"
      data-reel-viewer-stub-gone
      onclick={() => onMediaGone(startPost.id)}
    ></button>
  {/if}
</div>
