<script lang="ts">
  import { Keyboard, X } from '@lucide/svelte';
  import { coversScreen } from '$lib/actions/coversScreen.svelte';
  import { m } from '$lib/paraglide/messages';
  import GifGrid from './GifGrid.svelte';
  import type { GifResult } from '$lib/utils/chat/gifSearch';

  /**
   * THE GIF PANEL THAT TAKES THE KEYBOARD'S PLACE (user, 2026-10-02: *"un panneau de la taille du
   * clavier qui s'ouvre a sa place"* - Messenger's, Discord's, WhatsApp's).
   *
   * It is the LAST child of the composer's footer, so the composer sits on top of it exactly where it
   * sits on top of the keyboard. Its box is `spacerPx` tall - the reserved height minus what the
   * keyboard currently covers (`panelSpacerPx`) - and its content keeps `contentPx`, anchored at the
   * top and clipped: while the keyboard falls away under an opening panel, or rises into a closing
   * one, the box grows or shrinks by exactly what the keyboard uncovers or takes, and the composer
   * above it does not move. The content's own bottom padding keeps the home indicator or the gesture
   * bar clear, since the panel covers the strip the keyboard covers.
   */
  interface Props {
    /** Whether the panel is drawn (the `gif` state), as opposed to only holding its room. */
    active: boolean;
    spacerPx: number;
    contentPx: number;
    onPick: (gif: GifResult) => void;
    onSearchFocusChange: (focused: boolean) => void;
    /** Gives the room back to the keyboard: focuses the text field. */
    onKeyboard: () => void;
    /**
     * THE SEARCH IS OPEN (user, 2026-10-05): the picker is the whole screen above the keyboard - the
     * search row and as many results as fit - and the conversation is not needed. The box in the
     * footer stays as it is, so the conversation underneath lays out exactly as before and closing
     * the picker puts it back where it was; only the content is lifted out, as a fixed layer
     * sized like the other keyboard-aware overlays (`.composer-gif-fullscreen`).
     */
    fullscreen: boolean;
    /** Closes the whole picker; the fullscreen layer has no composer under it to tap instead. */
    onClose: () => void;
  }

  let {
    active,
    spacerPx,
    contentPx,
    onPick,
    onSearchFocusChange,
    onKeyboard,
    fullscreen,
    onClose,
  }: Props = $props();

  /** A tap on the close button must not move focus: the search field would blur and the keyboard fall. */
  function keepFocus(e: MouseEvent): void {
    e.preventDefault();
  }
</script>

<div
  class="composer-gif-panel pointer-events-auto overflow-hidden"
  style="height: {spacerPx}px"
  data-testid="composer-gif-panel"
  role="region"
  aria-label={m.chat_gif_search_label()}
>
  <div
    class="flex flex-col {fullscreen ? 'composer-gif-fullscreen' : ''}"
    style={fullscreen
      ? undefined
      : `height: ${contentPx}px; padding-bottom: var(--safe-area-inset-bottom, 0px)`}
    aria-hidden={!active}
    inert={!active}
    use:coversScreen={fullscreen}
  >
    <GifGrid {active} {onPick} {onSearchFocusChange}>
      {#snippet trailing()}
        {#if fullscreen}
          <button
            type="button"
            onmousedown={keepFocus}
            onclick={onClose}
            aria-label={m.common_close_label()}
            title={m.common_close_label()}
            class="ui-icon-button text-text-muted rounded-xl hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X size={20} />
          </button>
        {:else}
          <button
            type="button"
            onclick={onKeyboard}
            aria-label={m.chat_gif_back_to_keyboard_label()}
            title={m.chat_gif_back_to_keyboard_label()}
            class="ui-icon-button text-text-muted rounded-xl hover:bg-black/5 dark:hover:bg-white/10"
          >
            <Keyboard size={20} />
          </button>
        {/if}
      {/snippet}
    </GifGrid>
  </div>
</div>
