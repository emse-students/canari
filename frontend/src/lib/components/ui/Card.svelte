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

<div class="border-cn-border bg-cn-surface rounded-3xl border p-6 shadow-sm {className}">
  {#if title}
    <h3 class="text-text-main mb-4 px-1 text-xl font-bold">{title}</h3>
  {/if}
  {@render children?.()}
</div>
