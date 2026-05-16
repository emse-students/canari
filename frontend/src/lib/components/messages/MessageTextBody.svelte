<script lang="ts">
  import { isGifUrl, getGifEmbedUrl, splitWithHighlight } from '$lib/utils/chat/messageDisplay';
  import LinkPreviewCard from './LinkPreviewCard.svelte';

  interface TextSegment {
    type: 'text' | 'link';
    value: string;
  }

  interface Props {
    /** Pre-split text+link segments produced by splitTextWithLinks. */
    textSegments: TextSegment[];
    /** Active search term for in-text highlighting (empty string = no highlight). */
    searchTerm: string;
    /** When true, renders text in italic with reduced opacity. */
    isDeleted: boolean;
    /** First HTTP URL in the text, used to show a link preview card below the message. */
    firstLink: string | null;
  }

  let { textSegments, searchTerm, isDeleted, firstLink }: Props = $props();

  const normalizedSearchTerm = $derived(searchTerm.trim().toLowerCase());

  type MentionPart = { type: 'text' | 'mention' | 'hashtag'; value: string };
  function splitWithMentions(text: string): MentionPart[] {
    const parts: MentionPart[] = [];
    const pattern = /(@[\wÀ-ž]{1,50}|#[\wÀ-ž]{2,50})/g;
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIdx) parts.push({ type: 'text', value: text.slice(lastIdx, match.index) });
      const token = match[0];
      if (token.startsWith('@')) parts.push({ type: 'mention', value: token.slice(1) });
      else parts.push({ type: 'hashtag', value: token.slice(1) });
      lastIdx = match.index + token.length;
    }
    if (lastIdx < text.length) parts.push({ type: 'text', value: text.slice(lastIdx) });
    return parts;
  }
</script>

<p
  class="text-[0.95rem] leading-relaxed break-words whitespace-pre-wrap [overflow-wrap:anywhere] {isDeleted
    ? 'italic opacity-60'
    : ''}"
>
  {#each textSegments as segment, index (`${segment.type}-${segment.value}-${index}`)}
    {#if segment.type === 'link'}
      {#if isGifUrl(segment.value)}
        <span class="block my-1.5">
          <img
            src={getGifEmbedUrl(segment.value)}
            alt="GIF"
            class="rounded-xl max-h-64 max-w-full object-contain shadow-sm"
            onerror={(e) => {
              const img = e.currentTarget;
              if (img instanceof HTMLImageElement) {
                img.style.display = 'none';
                const link = document.createElement('a');
                link.href = segment.value;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = segment.value;
                link.className =
                  'underline underline-offset-2 decoration-current hover:opacity-80 transition-opacity';
                img.parentElement?.appendChild(link);
              }
            }}
          />
        </span>
      {:else}
        <a
          href={segment.value}
          target="_blank"
          rel="noopener noreferrer"
          class="underline underline-offset-2 decoration-current hover:opacity-80 font-medium transition-opacity"
          onclick={(e) => e.stopPropagation()}
        >
          {segment.value}
        </a>
      {/if}
    {:else}
      {#each splitWithHighlight(segment.value, normalizedSearchTerm) as part, pIndex (`${pIndex}-${part.text}`)}
        {#if part.hit}
          <mark class="rounded px-0.5 bg-amber-300/60 text-inherit">{part.text}</mark>
        {:else}
          {#each splitWithMentions(part.text) as mp (`${mp.type}-${mp.value}`)}
            {#if mp.type === 'mention'}
              <span class="font-semibold text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded-full px-1 text-[0.9em]">@{mp.value}</span>
            {:else if mp.type === 'hashtag'}
              <span class="font-semibold text-amber-600/80 dark:text-amber-400/70">#{mp.value}</span>
            {:else}
              {mp.value}
            {/if}
          {/each}
        {/if}
      {/each}
    {/if}
  {/each}
</p>
{#if firstLink}
  <LinkPreviewCard url={firstLink} />
{/if}
