<script lang="ts">
  import { resolveMediaType } from '$lib/utils/mediaLayout';
  import { capturePosterOf } from '$lib/reels/capturePoster';

  /**
   * The thumbnail of a picture or a video picked in the post composer or editor, before upload.
   *
   * A VIDEO IS DRAWN BY A `<video>`, NEVER AN `<img>`. Both forms put every previewable pick's
   * object URL in an `<img>`, so a video - picked from the gallery or just filmed with "Filmer" -
   * showed a broken image and its alt text (Mi 9T, 2026-09-29). The element is muted, inline and
   * `preload="metadata"`, and its URL carries `#t=0.1`: without a seek the Android WebView decodes
   * no frame and draws its grey default poster instead (Mi 9T, measured). It never plays.
   * Files with no frame at all are the caller's icon card (`needsThumbIcon`).
   *
   * A VIDEO FILMED BY THE IN-APP CAMERA IS DRAWN BY ITS POSTER. A recorder's file has no seek index,
   * so the `#t=0.1` seek decodes nothing and the tile stayed grey (Mi 9T, v1.2.9-alpha.1); the camera
   * attached the take's first picture to the file (`capturePoster.ts`), and that picture is drawn.
   */
  interface Props {
    file: File;
    src: string;
    alt: string;
    class?: string;
  }

  let { file, src, alt, class: className = '' }: Props = $props();

  const isVideo = $derived(resolveMediaType({ mimeType: file.type }) === 'video');
  const poster = $derived(isVideo ? capturePosterOf(file) : undefined);
  /** The poster's object URL, made and revoked with the poster it shows. */
  let posterUrl = $state<string | null>(null);

  $effect(() => {
    if (!poster) {
      posterUrl = null;
      return;
    }
    const url = URL.createObjectURL(poster);
    posterUrl = url;
    return () => URL.revokeObjectURL(url);
  });
</script>

{#if isVideo && poster}
  {#if posterUrl}
    <img
      src={posterUrl}
      {alt}
      class="h-full w-full object-cover {className}"
      data-picked-media-poster
    />
  {/if}
{:else if isVideo}
  <video
    src="{src}#t=0.1"
    aria-label={alt}
    muted
    playsinline
    preload="metadata"
    class="h-full w-full object-cover {className}"
  ></video>
{:else}
  <img {src} {alt} class="h-full w-full object-cover {className}" />
{/if}
