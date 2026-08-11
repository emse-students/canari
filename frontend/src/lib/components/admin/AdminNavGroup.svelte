<script lang="ts">
  import type { Component } from 'svelte';
  import { ChevronDown } from '@lucide/svelte';
  import { portal } from '$lib/actions/portal';
  import { bindFixedPopover } from '$lib/actions/fixedPopover';

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
  let buttonEl = $state<HTMLElement | null>(null);
  let panelEl = $state<HTMLElement | null>(null);

  // The nav bar scrolls horizontally (`overflow-x-auto`), which forces the browser to clip the
  // vertical axis too - an `absolute` panel anchored inside it never becomes visible, and every
  // page is itself wrapped in `.page-scroll-wrap` (`will-change: transform`), which makes IT the
  // containing block for a merely `fixed` descendant instead of the viewport. `use:portal` moves
  // the panel out of both ancestors; `bindFixedPopover` then positions it against the button's own
  // viewport rect (see docs/wiki/frontend/architecture.md "An anchored dropdown must be portalled").
  $effect(() => {
    if (!open || !panelEl || !buttonEl) return;
    const unbind = bindFixedPopover(panelEl, { anchor: () => buttonEl, estimatedHeight: 220 });
    return unbind;
  });
</script>

<div class="shrink-0">
  <button
    bind:this={buttonEl}
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
    <!-- Full-screen invisible backdrop, below the panel: closes on any outside click, matching
         PostNotificationBell rather than clickOutside - the panel no longer being a DOM descendant
         of this wrapper once portalled, composedPath() would treat every click inside it as
         "outside" too. -->
    <div
      use:portal
      role="presentation"
      class="fixed inset-0 z-[190]"
      onclick={() => (open = false)}
    ></div>
    <div
      bind:this={panelEl}
      use:portal
      class="fixed z-[200] min-w-52 rounded-2xl border border-black/8 dark:border-white/10 bg-cn-surface/95 backdrop-blur-xl shadow-lg p-1.5 space-y-0.5"
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
