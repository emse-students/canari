<script lang="ts">
  import { splitTextWithMentions } from '$lib/utils/mentions.parse';
  import MessageMentionChip from './MessageMentionChip.svelte';

  /**
   * ONE PLAIN-TEXT RUN OF A MESSAGE, WITH ITS MENTIONS AND HASHTAGS RENDERED AS SUCH.
   *
   * It exists because a message with an attachment is NOT rendered by `MessageTextBody`:
   * `MessageBubble` guards that component with `{#if !mediaRef}` and hands the caption to
   * `MessageMediaRenderer` instead, which printed `segment.value` verbatim. So a photo captioned
   * `Dans le retro @[7283faf1...]` read exactly that on screen - the 64-hex wire token, forever,
   * because nothing on that path ever asks for a name. Reported by the user on 2026-09-23, who read
   * it as a cache that never warms: *"le refresh ou le relancement de l'app ne fait rien"*. It is
   * not a cache. The resolver was never reached.
   *
   * THE TWO PATHS NOW SHARE THIS COMPONENT RATHER THAN EACH SPELLING THE PARSE. A caption and a
   * body differ in what WRAPS the text - the `<p>`, the search highlight, the link preview card -
   * and in nothing about what the text MEANS. Spelling the mention/hashtag cases twice is what let
   * one of them be written without the other in the first place, and a third surface (a pinned
   * message, a quoted forward) would have made the same omission on its own.
   *
   * The caller keeps the link segments: only it knows whether a bare URL embeds a GIF, opens a
   * preview card, or is simply clickable.
   */
  interface Props {
    /** A run of text carrying no URL - the caller has already split those out. */
    text: string;
  }

  let { text }: Props = $props();
</script>

{#each splitTextWithMentions(text) as part, index (`${index}-${part.type}-${'userId' in part ? part.userId : part.value}`)}
  {#if part.type === 'mention'}
    <MessageMentionChip userId={part.userId} />
  {:else if part.type === 'hashtag'}
    <!-- IT TAKES THE BUBBLE'S OWN COLOUR, because the bubble is the only thing that knows what it
         is filled with. `text-amber-600/80 dark:text-amber-400/70` was 1.68:1 on the outgoing
         yellow in light mode and 1.13:1 in dark - *"les # ne sont pas forcement visibles (jaune sur
         jaune)"* (user, 2026-09-20), measured against the four bubble fills. `currentColor` is
         10.35:1 and 12.10:1 there and the body contrast everywhere else, by construction rather
         than by remembering. The hashtag is told apart by WEIGHT and by the `#` itself, which is
         all that survives any fill this bubble is ever given.

         NO TINT BEHIND IT, and that is deliberate: `bg-current/8` compiles to `color-mix(...)`
         guarded by `@supports`, and its fallback is `currentColor` at FULL opacity - a solid block
         in the text's own colour, behind text of that colour. A WebView without `color-mix` would
         hide the word completely, which is the defect being fixed, made worse. -->
    <span class="font-semibold">#{part.value}</span>
  {:else}
    {part.value}
  {/if}
{/each}
