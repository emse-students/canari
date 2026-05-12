<script lang="ts">
  interface Props {
    /** Additional CSS classes forwarded to the card wrapper. */
    class?: string;
    /** Slot content rendered inside the card body. */
    children?: import('svelte').Snippet;
    /** Optional heading displayed at the top of the card. */
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
