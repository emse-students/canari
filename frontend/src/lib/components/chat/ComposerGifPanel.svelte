<script lang="ts">
  import { Keyboard } from '@lucide/svelte';
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
  }

  let { active, spacerPx, contentPx, onPick, onSearchFocusChange, onKeyboard }: Props = $props();
</script>

<div
  class="composer-gif-panel pointer-events-auto overflow-hidden"
  style="height: {spacerPx}px"
  data-testid="composer-gif-panel"
  role="region"
  aria-label={m.chat_gif_search_label()}
>
  <div
    class="flex flex-col"
    style="height: {contentPx}px; padding-bottom: var(--safe-area-inset-bottom, 0px)"
    aria-hidden={!active}
    inert={!active}
  >
    <GifGrid {active} {onPick} {onSearchFocusChange}>
      {#snippet trailing()}
        <button
          type="button"
          onclick={onKeyboard}
          aria-label={m.chat_gif_back_to_keyboard_label()}
          title={m.chat_gif_back_to_keyboard_label()}
          class="ui-icon-button text-text-muted rounded-xl hover:bg-black/5 dark:hover:bg-white/10"
        >
          <Keyboard size={20} />
        </button>
      {/snippet}
    </GifGrid>
  </div>
</div>
