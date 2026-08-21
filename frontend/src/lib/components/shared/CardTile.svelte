<script lang="ts">
  import type { Component, Snippet } from 'svelte';

  interface Props {
    /** Custom icon image (e.g. a partner brand's logo); falls back to `fallbackIcon` when null/unset. */
    iconUrl?: string | null;
    /** Lucide (or compatible) icon component rendered when no custom `iconUrl` is set. */
    fallbackIcon: Component;
    /** Extra classes appended to the outer container. */
    class?: string;
    children: Snippet;
  }

  let { iconUrl, fallbackIcon: FallbackIcon, class: className = '', children }: Props = $props();
</script>

<div
  class="border-cn-border relative overflow-hidden rounded-2xl border bg-(--cn-surface) {className}"
>
  <div
    class="pointer-events-none absolute top-3 right-3 h-16 w-16 opacity-40"
    style="mask-image: radial-gradient(circle at top right, black 10%, transparent 90%); -webkit-mask-image: radial-gradient(circle at top right, black 10%, transparent 90%);"
  >
    {#if iconUrl}
      <img src={iconUrl} alt="" class="h-full w-full object-contain" />
    {:else}
      <FallbackIcon size={64} class="h-full w-full" />
    {/if}
  </div>
  <div class="relative h-full">
    {@render children()}
  </div>
</div>
