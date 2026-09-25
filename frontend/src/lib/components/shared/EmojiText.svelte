<script lang="ts">
  import { splitEmojiText } from '$lib/utils/emojiSvg';

  /**
   * A run of user text with every emoji drawn as Noto's SVG instead of the platform's glyph.
   *
   * Use it wherever user text is printed: it renders a text node for the text and an `<img>` per
   * emoji, and nothing else - no wrapper element, so it inherits the surrounding font, size, colour
   * and wrapping. The picture is sized in `em` by `img.emoji` in `app.css`, so it follows whatever
   * text it sits in, the jumbomoji size included.
   *
   * The `alt` is the emoji itself, which is what a copy of the selection carries in Chromium and
   * Firefox (measured in Chromium 2026-09-25: `salut 😀 ça va` round-trips through the clipboard),
   * and what a screen reader announces.
   */
  interface Props {
    /** The text to print. */
    text: string;
  }

  let { text }: Props = $props();
</script>

{#each splitEmojiText(text) as part, index (index)}
  {#if part.kind === 'emoji'}
    <img class="emoji" src={part.src} alt={part.value} draggable="false" />
  {:else}
    {part.value}
  {/if}
{/each}
