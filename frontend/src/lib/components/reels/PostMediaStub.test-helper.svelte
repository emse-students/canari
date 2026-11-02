<script lang="ts">
  import type { MediaFailureCause } from '$lib/utils/mediaErrors';
  /**
   * Stands in for `PostMedia` in the reel viewer tests: which media would play, nothing fetched.
   * It says whether the minimal reel player was asked for and which poster it was handed. A test
   * reports the file whole by dispatching `stubloaded` on it (`onLoaded`), and playback by
   * dispatching `playing` (`stubblocked` for a refused autoplay), which the slide hears in its capture phase as it would a `<video>`'s.
   * A typed download failure is `stubfailed`, a `CustomEvent` whose detail is the cause (`onFailure`).
   */
  let {
    media,
    minimalPlayer,
    poster,
    onLoaded,
    onPlaybackBlocked,
    onFailure,
  }: {
    media: { mediaId: string };
    minimalPlayer?: boolean;
    poster?: string | null;
    onLoaded?: (url: string) => void;
    onPlaybackBlocked?: (cause: 'refused' | 'unplayable' | 'failed') => void;
    onFailure?: (cause: MediaFailureCause) => void;
  } = $props();

  let el = $state<HTMLDivElement | undefined>();
  $effect(() => {
    if (!el) return;
    const report = () => onLoaded?.(`blob:${media.mediaId}`);
    const block = () => onPlaybackBlocked?.('refused');
    const fail = (e: Event) => onFailure?.((e as CustomEvent<MediaFailureCause>).detail);
    el.addEventListener('stubloaded', report);
    el.addEventListener('stubblocked', block);
    el.addEventListener('stubfailed', fail);
    return () => {
      el?.removeEventListener('stubloaded', report);
      el?.removeEventListener('stubblocked', block);
      el?.removeEventListener('stubfailed', fail);
    };
  });
</script>

<div
  data-post-media-stub={media.mediaId}
  data-minimal-player={minimalPlayer ? '' : undefined}
  data-poster={poster ?? undefined}
  bind:this={el}
></div>
