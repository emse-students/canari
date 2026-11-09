<script lang="ts">
  import { emojiDisplayParts, type EmojiStyle } from '$lib/utils/emojiStyle';

  /**
   * A run of user text, every emoji drawn as the user's emoji setting says (`emojiStyle.ts`): the
   * platform's glyph by default, or Noto's SVG under "Canari".
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
    /**
     * Overrides the user's setting - ONLY for an artefact others see (the PDF poster), which keeps
     * the pictures on every device. Everything the user reads in the app leaves it unset.
     */
    emojiStyle?: EmojiStyle;
  }

  let { text, emojiStyle }: Props = $props();
</script>

{#each emojiDisplayParts(text, emojiStyle) as part, index (index)}
  {#if part.kind === 'emoji'}
    <img class="emoji" src={part.src} alt={part.value} draggable="false" />
  {:else}
    {part.value}
  {/if}
{/each}
