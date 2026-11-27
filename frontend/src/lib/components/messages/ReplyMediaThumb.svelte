<!--
  @component
  A QUOTED PHOTO OR VIDEO, SMALL AND DIMMED (owner, 2026-11-27: the quote said "Photo" where
  Messenger shows the picture). Purely presentational: `MessageReplyQuote` decides what the device
  holds (a decrypted photo in memory, or the sender's embedded ThumbHash) and never fetches anything.
  A video is drawn from its ThumbHash only: pinning a video blob for a quote would keep it alive.
  The accessible name (`alt`) stays the kind label.
  docs/wiki/frontend/modules/chat.md
-->
<script lang="ts">
  interface Props {
    /** A decrypted blob URL held in memory, or a ThumbHash data URL. */
    src: string;
    /** What the attachment is in words ("Photo"), kept as the accessible name. */
    label: string;
    width?: number;
    height?: number;
  }

  let { src, label, width, height }: Props = $props();
</script>

<img
  {src}
  alt={label}
  {width}
  {height}
  draggable="false"
  data-testid="reply-media-thumb"
  class="block h-auto max-h-20 w-auto max-w-40 rounded-lg object-contain opacity-60 select-none"
/>
