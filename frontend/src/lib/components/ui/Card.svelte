<script lang="ts">
  interface Props {
    class?: string;
    children?: import('svelte').Snippet;
    title?: string;
  }

  let { class: className = '', children, title }: Props = $props();
</script>

<div
  class="bg-[var(--cn-surface)]/80 backdrop-blur-xl border border-cn-border rounded-3xl p-6 shadow-sm {className}"
>
  {#if title}
    <h3 class="text-xl font-bold text-text-main mb-4 px-1">{title}</h3>
  {/if}
  {@render children?.()}
</div>
