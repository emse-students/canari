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
    /**
     * Caps h1/h2/h3 to the same size as body text (still bold/extrabold, so a heading is still
     * visually distinct - just not headline-sized). For a description shown as a short preview
     * next to the entity's OWN name (an association/list card, a group header) - a genuine
     * headline-sized `# Title` there would outrank the name it's describing, which is the one
     * piece of text that preview actually exists to show. Off by default: a full "A propos" /
     * profile bio display is exactly where a real heading hierarchy belongs.
     */
    compact?: boolean;
  }

  let { source, class: className = '', compact = false }: Props = $props();

  onMount(() => {
    ensureHljsTheme();
  });

  const rendered = $derived(preprocessPostMarkdown(source.trim()));
  const renderers = { link: PostMentionLink, code: PostCodeBlock, codespan: PostCodespan };

  /**
   * Heading sizes are `em`, not `rem`, even in the non-compact case: several callers shrink this
   * component's own font-size with an ancestor override like `[&_.post-markdown]:text-xs` to fit
   * a smaller context. A `rem` heading ignores that entirely and renders at its fixed absolute
   * size regardless of context. `em` scales with whatever size `.post-markdown` itself ends up
   * at, so the ratio between heading and body text is preserved wherever this is used.
   */
  const headingClasses = $derived(
    compact
      ? '[&_h1]:text-[1em] [&_h1]:leading-tight [&_h1]:font-extrabold [&_h2]:text-[1em] [&_h2]:font-bold [&_h3]:text-[1em] [&_h3]:font-bold'
      : '[&_h1]:text-[1.526em] [&_h1]:leading-tight [&_h1]:font-extrabold [&_h2]:text-[1.316em] [&_h2]:font-bold [&_h3]:text-[1.158em] [&_h3]:font-bold'
  );
</script>

<div
  class="post-markdown text-text-main max-w-none text-[0.95rem] leading-relaxed opacity-90 [&_a]:break-words [&_br]:block [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-3 [&_p:first-child]:mt-0 [&_ul]:list-disc [&_ul]:pl-5 {headingClasses} {className}"
>
  <SvelteMarkdown source={rendered} {renderers} options={{ gfm: true, breaks: true }} />
</div>
