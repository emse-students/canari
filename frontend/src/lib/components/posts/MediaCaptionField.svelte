<script lang="ts">
  import { m } from '$lib/paraglide/messages';

  /**
   * The ONE caption field of the composer and the editor, under the thumbnail strip, for the media
   * whose `MediaCaptionChip` was tapped. Enter or the same chip closes it; what was typed stays.
   * Not a blur: a blur fires BEFORE the chip's click, so tapping the chip to close would reopen it.
   */
  interface Props {
    value: string;
    /** 1-based position of the media it captions, so the placeholder says which one. */
    position: number;
    onDone: () => void;
  }

  let { value = $bindable(''), position, onDone }: Props = $props();

  /** Focused on mount: the chip was tapped to type, so the keyboard should already be up. */
  function focusOnMount(node: HTMLInputElement) {
    node.focus({ preventScroll: true });
  }
</script>

<input
  type="text"
  bind:value
  use:focusOnMount
  maxlength="120"
  placeholder={m.post_composer_caption_placeholder({ position })}
  aria-label={m.post_composer_caption_placeholder({ position })}
  enterkeyhint="done"
  onkeydown={(e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onDone();
    }
  }}
  class="text-text-main placeholder:text-text-muted/70 border-cn-border mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-amber-500"
/>
