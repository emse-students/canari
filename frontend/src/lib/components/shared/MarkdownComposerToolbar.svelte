<script lang="ts">
  import {
    Bold,
    Code,
    Heading2,
    Italic,
    Link2,
    List,
    Quote,
    Strikethrough,
  } from '@lucide/svelte';

  interface Props {
    /** Called with format id (`bold`, `italic`, `heading`, …). */
    onFormat: (type: string) => void;
    class?: string;
  }

  let { onFormat, class: className = '' }: Props = $props();

  const btnClass =
    'p-1.5 rounded-lg text-text-muted hover:bg-black/10 dark:hover:bg-white/10 hover:text-text-main transition-colors outline-none focus-visible:ring-1 focus-visible:ring-amber-500';
</script>

<div
  class="flex items-center gap-0.5 px-2 pt-1.5 pb-1.5 flex-wrap border-b border-black/5 dark:border-white/5 {className}"
  role="toolbar"
  aria-label="Mise en forme"
>
  <button type="button" title="Gras" class={btnClass} onclick={() => onFormat('bold')}>
    <Bold size={15} strokeWidth={2} />
  </button>
  <button type="button" title="Italique" class={btnClass} onclick={() => onFormat('italic')}>
    <Italic size={15} strokeWidth={2} />
  </button>
  <button type="button" title="Barré" class={btnClass} onclick={() => onFormat('strikethrough')}>
    <Strikethrough size={15} strokeWidth={2} />
  </button>
  <div class="h-4 w-px bg-black/10 dark:bg-white/10 mx-1 shrink-0" aria-hidden="true"></div>
  <button type="button" title="Titre" class={btnClass} onclick={() => onFormat('heading')}>
    <Heading2 size={15} strokeWidth={2} />
  </button>
  <button type="button" title="Citation" class={btnClass} onclick={() => onFormat('quote')}>
    <Quote size={15} strokeWidth={2} />
  </button>
  <button type="button" title="Code" class={btnClass} onclick={() => onFormat('code')}>
    <Code size={15} strokeWidth={2} />
  </button>
  <div class="h-4 w-px bg-black/10 dark:bg-white/10 mx-1 shrink-0" aria-hidden="true"></div>
  <button type="button" title="Liste" class={btnClass} onclick={() => onFormat('list')}>
    <List size={15} strokeWidth={2} />
  </button>
  <button type="button" title="Lien" class={btnClass} onclick={() => onFormat('link')}>
    <Link2 size={15} strokeWidth={2} />
  </button>
</div>
