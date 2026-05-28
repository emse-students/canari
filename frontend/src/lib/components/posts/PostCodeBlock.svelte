<script lang="ts">
  import { onMount } from 'svelte';
  import { highlightCode } from '$lib/utils/posts/codeHighlight';
  import { ensureHljsTheme } from '$lib/utils/posts/hljsTheme';

  interface Props {
    lang: string;
    text: string;
  }

  let { lang, text }: Props = $props();

  let codeEl = $state<HTMLElement | null>(null);

  onMount(() => {
    ensureHljsTheme();
  });

  const highlighted = $derived(highlightCode(text, lang));
  const label = $derived(
    highlighted.language && highlighted.language !== 'text' ? highlighted.language : lang || ''
  );

  // highlight.js output (escaped source + <span class="hljs-…"> only) - see codeHighlight.ts
  $effect(() => {
    if (!codeEl) return;
    // eslint-disable-next-line svelte/no-dom-manipulating -- safe HTML from highlight.js only
    codeEl.innerHTML = highlighted.html;
  });
</script>

<div
  class="post-code-block group relative my-3 overflow-hidden rounded-xl border border-cn-border/70 bg-black/[0.03] dark:bg-white/[0.05]"
>
  {#if label}
    <span
      class="absolute right-2.5 top-2 z-10 rounded-md bg-black/5 px-1.5 py-0.5 font-mono text-[0.62rem] font-semibold uppercase tracking-wide text-text-muted dark:bg-white/10"
    >
      {label}
    </span>
  {/if}
  <pre class="hljs m-0 overflow-x-auto p-4 text-[0.82rem] leading-relaxed"><code bind:this={codeEl}
    ></code></pre>
</div>
