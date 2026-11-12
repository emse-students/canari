<script lang="ts">
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import { splitTextWithMentions } from '$lib/utils/mentions.parse';
  import LiveChatMention from './LiveChatMention.svelte';

  /**
   * THE TEXT OF ONE LIVE CHAT LINE: plain text with its emoji drawn as Noto SVG, and each `@[id]`
   * token drawn as a tappable mention (owner, 2026-11-09). Still never markup and never a link (C15):
   * a `#word` is shown as typed, and the parser's other parts are text.
   */
  interface Props {
    text: string;
  }

  let { text }: Props = $props();
</script>

{#each splitTextWithMentions(text) as part, index (`${index}-${part.type}`)}
  {#if part.type === 'mention'}
    <LiveChatMention userId={part.userId} />
  {:else if part.type === 'hashtag'}
    <EmojiText text={`#${part.value}`} />
  {:else}
    <EmojiText text={part.value} />
  {/if}
{/each}
