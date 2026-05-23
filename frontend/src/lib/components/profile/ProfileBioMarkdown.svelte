<script lang="ts">
  import { onMount } from 'svelte';
  import SvelteMarkdown from '@humanspeak/svelte-markdown';
  import PostMentionLink from '$lib/components/posts/PostMentionLink.svelte';
  import PostCodeBlock from '$lib/components/posts/PostCodeBlock.svelte';
  import PostCodespan from '$lib/components/posts/PostCodespan.svelte';
  import { preprocessPostMarkdown } from '$lib/utils/posts/postMarkdown';
  import { ensureHljsTheme } from '$lib/utils/posts/hljsTheme';

  interface Props {
    /** Raw bio text (Markdown). */
    source: string;
    /** Extra classes on the wrapper. */
    class?: string;
  }

  let { source, class: className = '' }: Props = $props();

  onMount(() => {
    ensureHljsTheme();
  });

  const rendered = $derived(preprocessPostMarkdown(source.trim()));
  const renderers = { link: PostMentionLink, code: PostCodeBlock, codespan: PostCodespan };
</script>

<div
  class="post-markdown max-w-none text-[0.95rem] text-text-main leading-relaxed opacity-90 [&_br]:block [&_p+p]:mt-3 [&_p:first-child]:mt-0 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:break-words [&_h1]:text-[1.45rem] [&_h1]:font-extrabold [&_h1]:leading-tight [&_h2]:text-[1.25rem] [&_h2]:font-bold [&_h3]:text-[1.1rem] [&_h3]:font-bold {className}"
>
  <SvelteMarkdown source={rendered} {renderers} options={{ gfm: true, breaks: true }} />
</div>
