<script lang="ts">
  import type { Component } from 'svelte';
  import { ChevronDown } from '@lucide/svelte';
  import { clickOutside } from '$lib/actions/clickOutside';

  interface NavGroupItem {
    href: string;
    label: string;
    icon: Component;
  }

  interface Props {
    /** Group button label. */
    label: string;
    /** Lucide (or compatible) icon component for the group button. */
    icon: Component;
    /** Sub-pages revealed in the dropdown. */
    items: NavGroupItem[];
    /** Whether the current route is one of `items` - highlights the group button. */
    active: boolean;
  }

  let { label, icon: Icon, items, active }: Props = $props();

  let open = $state(false);
</script>

<div class="relative shrink-0" use:clickOutside={() => (open = false)}>
  <button
    type="button"
    onclick={() => (open = !open)}
    aria-expanded={open}
    class="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-bold transition-colors
    {active
      ? 'bg-cn-yellow text-cn-ink shadow-sm'
      : 'border border-cn-border text-text-muted hover:text-text-main'}"
  >
    <Icon size={15} />
    {label}
    <ChevronDown size={14} class="transition-transform {open ? 'rotate-180' : ''}" />
  </button>
  {#if open}
    <div
      class="absolute left-0 top-full z-30 mt-1.5 min-w-52 rounded-2xl border border-black/8 dark:border-white/10 bg-cn-surface/95 backdrop-blur-xl shadow-lg p-1.5 space-y-0.5"
    >
      {#each items as item (item.href)}
        <a
          href={item.href}
          onclick={() => (open = false)}
          class="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold text-text-main hover:bg-cn-yellow/15 transition-colors"
        >
          <item.icon size={15} />
          {item.label}
        </a>
      {/each}
    </div>
  {/if}
</div>
