<script lang="ts">
  import SvelteMarkdown from '@humanspeak/svelte-markdown';
  import PostMentionLink from '$lib/components/posts/PostMentionLink.svelte';
  import { preprocessPostMarkdown } from '$lib/utils/posts/postMarkdown';

  interface Props {
    /** Raw bio text (Markdown). */
    source: string;
    /** Extra classes on the wrapper. */
    class?: string;
  }

  let { source, class: className = '' }: Props = $props();

  const rendered = $derived(preprocessPostMarkdown(source.trim()));
  const renderers = { link: PostMentionLink };
</script>

<div
  class="post-markdown max-w-none text-[0.95rem] text-text-main leading-relaxed opacity-90 [&_br]:block [&_p+p]:mt-3 [&_p:first-child]:mt-0 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:break-words {className}"
>
  <SvelteMarkdown source={rendered} {renderers} options={{ gfm: true, breaks: true }} />
</div>
