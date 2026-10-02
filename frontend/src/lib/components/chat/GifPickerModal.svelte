<script lang="ts">
  import { X } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import ModalOverlay from '$lib/components/shared/ModalOverlay.svelte';
  import GifGrid from './GifGrid.svelte';
  import type { GifResult } from '$lib/utils/chat/gifSearch';

  /**
   * The DESKTOP GIF picker: the same search and grid as the phone's keyboard-sized panel
   * (`GifGrid`), in a dialog - a desktop has no keyboard whose place a panel could take.
   */
  interface Props {
    open: boolean;
    onClose: () => void;
    /** Called with the GIF picked; the dialog closes itself. */
    onSelect: (gif: GifResult) => void;
  }

  let { open, onClose, onSelect }: Props = $props();
</script>

<!--
  NO SCRIM (user, 2026-09-13: *"pas besoin de fond fonce"*). `scrim={false}` drops the dark plate and
  keeps the full-bleed click-to-close target, which is what the scrim was FOR - the dimming was
  never load-bearing. Removing the colour by removing the ELEMENT is how a modal becomes uncloseable
  on a phone, where there is no Escape key.

  The portal that #585 added here is now unconditional in `ModalOverlay`, with that measurement
  written into its docblock - `PollComposerModal` had the identical defect and nobody had met it.
-->
<ModalOverlay
  {open}
  {onClose}
  label={m.chat_gif_search_label()}
  layer="sheet"
  scrim={false}
  panelClass="flex h-[70vh] max-h-[80vh] w-full flex-col rounded-t-2xl bg-(--cn-surface) shadow-2xl sm:max-w-lg sm:rounded-2xl"
>
  <GifGrid
    active={open}
    onPick={(gif) => {
      onSelect(gif);
      onClose();
    }}
  >
    {#snippet trailing()}
      <button
        type="button"
        onclick={onClose}
        class="ui-icon-button text-text-muted rounded-xl hover:bg-black/5 dark:hover:bg-white/10"
        aria-label={m.common_close_label()}
      >
        <X size={18} />
      </button>
    {/snippet}
  </GifGrid>
</ModalOverlay>
