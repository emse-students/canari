<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import { LoaderCircle } from '@lucide/svelte';

  interface Props {
    icon: Component<{ size?: number; strokeWidth?: number }>;
    heading: string;
    /** Shows a spinner beside the heading while the section's data is still arriving. */
    loading?: boolean;
    children: Snippet;
  }

  let { icon: Icon, heading, loading = false, children }: Props = $props();
</script>

<!-- The card every profile section shares: an icon, a heading, then the section's own body. -->
<div
  class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm duration-500 md:p-8"
>
  <div class="mb-5 flex items-center gap-3">
    <div class="bg-cn-yellow/10 text-cn-dark rounded-xl p-2.5">
      <Icon size={22} strokeWidth={2.5} />
    </div>
    <h2 class="text-text-main text-lg font-bold">{heading}</h2>
    {#if loading}
      <LoaderCircle size={16} class="text-cn-yellow animate-spin" />
    {/if}
  </div>
  {@render children()}
</div>
