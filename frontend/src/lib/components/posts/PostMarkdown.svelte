<script lang="ts">
  /**
   * A POST'S TEXT, RENDERED ONCE FOR EVERY PLACE THAT SHOWS IT - the post card and the reel viewer's
   * caption. The source goes through `preprocessPostMarkdown` and the post renderers
   * (`POST_MARKDOWN_RENDERERS`: links, mentions, code, no raw HTML), so a reel's description reads
   * exactly as its card does. The clamp, the colour and the box around it are the caller's; the
   * rendered element is handed back (`element`) so a caller can measure it.
   */
  import SvelteMarkdown from '@humanspeak/svelte-markdown';
  import { POST_MARKDOWN_RENDERERS as renderers } from './postMarkdownRenderers';
  import { preprocessPostMarkdown } from '$lib/utils/posts/postMarkdown';

  interface Props {
    /** The post's markdown source. */
    markdown: string;
    /** Classes added to the rendered box (the clamp, the opacity). */
    class?: string;
    /** The rendered box, for a caller that measures it. */
    element?: HTMLDivElement;
  }

  let { markdown, class: extra = '', element = $bindable() }: Props = $props();

  const source = $derived(preprocessPostMarkdown(markdown));
</script>

<div
  bind:this={element}
  class="post-markdown max-w-none {extra} [&_br]:block [&_h1]:mt-1 [&_h1]:mb-0.5 [&_h1]:text-xl [&_h1]:leading-tight [&_h1]:font-bold [&_h1]:tracking-tight [&_h1+_p]:mt-2 [&_h2]:mt-1 [&_h2]:mb-0.5 [&_h2]:text-lg [&_h2]:leading-snug [&_h2]:font-bold [&_h2+_p]:mt-2 [&_h3]:mt-0.5 [&_h3]:mb-0 [&_h3]:text-base [&_h3]:leading-snug [&_h3]:font-bold [&_h3+_p]:mt-1.5 [&_p+p]:mt-3 [&_p:first-child]:mt-0"
>
  <SvelteMarkdown {source} {renderers} options={{ gfm: true, breaks: true }} />
</div>
