<script lang="ts">
  /**
   * Stands in for `PostMedia` in the reel viewer tests: which media would play, nothing fetched.
   * It says whether the minimal reel player was asked for and which poster it was handed. A test
   * reports the file whole by dispatching `stubloaded` on it (`onLoaded`), and playback by
   * dispatching `playing` (`stubblocked` for a refused autoplay), which the slide hears in its capture phase as it would a `<video>`'s.
   */
  let {
    media,
    minimalPlayer,
    poster,
    onLoaded,
    onPlaybackBlocked,
  }: {
    media: { mediaId: string };
    minimalPlayer?: boolean;
    poster?: string | null;
    onLoaded?: (url: string) => void;
    onPlaybackBlocked?: (cause: 'refused' | 'unplayable' | 'failed') => void;
  } = $props();

  let el = $state<HTMLDivElement | undefined>();
  $effect(() => {
    if (!el) return;
    const report = () => onLoaded?.(`blob:${media.mediaId}`);
    const block = () => onPlaybackBlocked?.('refused');
    el.addEventListener('stubloaded', report);
    el.addEventListener('stubblocked', block);
    return () => {
      el?.removeEventListener('stubloaded', report);
      el?.removeEventListener('stubblocked', block);
    };
  });
</script>

<div
  data-post-media-stub={media.mediaId}
  data-minimal-player={minimalPlayer ? '' : undefined}
  data-poster={poster ?? undefined}
  bind:this={el}
></div>
