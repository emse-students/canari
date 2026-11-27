<!--
  @component
  A QUOTED PHOTO OR VIDEO, SMALL AND DIMMED (owner, 2026-11-27: the quote said "Photo" where
  Messenger shows the picture). Purely presentational: `MessageReplyQuote` decides what the device
  holds (a decrypted blob in memory, or the sender's embedded ThumbHash) and never fetches anything.
  A video draws its first frame from the held blob. The accessible name stays the kind label.
  docs/wiki/frontend/modules/chat.md
-->
<script lang="ts">
  interface Props {
    /** A decrypted blob URL held in memory, or a ThumbHash data URL. */
    src: string;
    /** True when `src` is a video blob, drawn as its first frame. */
    video?: boolean;
    /** What the attachment is in words ("Photo"), kept as the accessible name. */
    label: string;
    width?: number;
    height?: number;
  }

  let { src, video = false, label, width, height }: Props = $props();

  const box =
    'block h-auto max-h-20 w-auto max-w-40 rounded-lg object-contain opacity-60 select-none';
</script>

{#if video}
  <video
    src={`${src}#t=0.1`}
    preload="metadata"
    muted
    playsinline
    disablepictureinpicture
    aria-label={label}
    data-testid="reply-media-thumb"
    class={box}
  ></video>
{:else}
  <img
    {src}
    alt={label}
    aria-label={label}
    {width}
    {height}
    draggable="false"
    data-testid="reply-media-thumb"
    class={box}
  />
{/if}
