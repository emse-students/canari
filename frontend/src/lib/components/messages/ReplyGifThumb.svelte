<!--
  @component
  A QUOTED GIF, SMALL AND DIMMED (user, 2026-10-05: Messenger shows the picture, not its address).

  A reply to a GIF used to quote the GIF's raw URL as text. `gifPreviewUrl` decides what is a GIF -
  the one test the bubble and the list preview already share - and this draws it: capped in height,
  at reduced opacity so it reads as a quote and not as the message. The size the sender wrote into
  the URL (`#cn-size`) reserves the box before the picture arrives, so the quote does not grow when
  it loads. A GIF that cannot load becomes its `[GIF]` label, as `GifEmbed` becomes its link.
  docs/wiki/frontend/modules/chat.md
-->
<script lang="ts">
  import { gifSizeFromUrl } from '$lib/utils/chat/messageDisplay';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The picture's address, as `gifPreviewUrl` returned it (fragment included). */
    url: string;
    /** Extra classes for the box. */
    class?: string;
  }

  let { url, class: className = '' }: Props = $props();

  const declared = $derived(gifSizeFromUrl(url));
  let failed = $state(false);

  function onError(): void {
    Log.d('ReplyGifThumb', 'the quoted GIF did not load - showing its label instead');
    failed = true;
  }
</script>

{#if failed}
  <span class={className}>{m.chat_preview_gif()}</span>
{:else}
  <img
    src={url}
    alt={m.chat_preview_gif()}
    width={declared?.width}
    height={declared?.height}
    loading="lazy"
    draggable="false"
    data-testid="reply-gif-thumb"
    class="block h-auto max-h-20 w-auto max-w-40 rounded-lg object-contain opacity-60 select-none {className}"
    onerror={onError}
  />
{/if}
