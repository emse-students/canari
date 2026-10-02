<!--
  @component
  A GIF sent as a link, drawn in a frame of its own size BEFORE it loads.

  It was a bare `<img class="max-h-64">`: 0 px until the GIF arrived, then up to 256 px, and every
  row under it moved - on every device, every time (user, 2026-10-02). The size now comes from the
  URL's fragment (`withGifSize`, written by the picker) or, for an older link, from this device's
  first measurement of it. A GIF that cannot load becomes its link, as before.
  docs/wiki/frontend/media-frame.md
-->
<script lang="ts">
  import { getGifEmbedUrl, gifSizeFromUrl } from '$lib/utils/chat/messageDisplay';
  import { Log } from '$lib/utils/Log';
  import AppLink from '../shared/AppLink.svelte';
  import MediaFrame from '../shared/MediaFrame.svelte';

  interface Props {
    /** The GIF's URL as the message carries it, fragment included. */
    url: string;
  }

  let { url }: Props = $props();

  const declared = $derived(gifSizeFromUrl(url));
  let failed = $state(false);
  let loaded = $state(false);

  function onError(): void {
    Log.d('GifEmbed', 'the GIF did not load - showing its link instead');
    failed = true;
  }
</script>

{#if failed}
  <AppLink href={url} />
{:else}
  <MediaFrame
    tag="span"
    sizing="intrinsic"
    width={declared?.width}
    height={declared?.height}
    measureKey={url}
    class="my-1.5 rounded-xl shadow-sm {loaded ? '' : 'animate-pulse bg-black/5 dark:bg-white/10'}"
  >
    {#snippet children(frame)}
      <img
        src={getGifEmbedUrl(url)}
        alt="GIF"
        class="absolute inset-0 h-full w-full object-contain"
        onload={(e) => {
          loaded = true;
          frame.onLoad(e);
        }}
        onerror={onError}
      />
    {/snippet}
  </MediaFrame>
{/if}
