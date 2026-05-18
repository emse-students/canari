<script lang="ts">
  import { isGifUrl, getGifEmbedUrl, splitWithHighlight } from '$lib/utils/chat/messageDisplay';
  import { splitTextWithMentions } from '$lib/utils/mentions.parse';
  import LinkPreviewCard from './LinkPreviewCard.svelte';
  import MessageMentionChip from './MessageMentionChip.svelte';

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
          {#each splitTextWithMentions(part.text) as mp (`${mp.type}-${'userId' in mp ? mp.userId : ''}-${'value' in mp ? mp.value : ''}`)}
            {#if mp.type === 'mention'}
              <MessageMentionChip userId={mp.userId} name={mp.label} />
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
