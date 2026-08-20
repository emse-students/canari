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

  /**
   * Ties the button to the panel it reveals, which is the only thing that makes `aria-expanded`
   * mean anything: on its own it announces "expanded" without naming what expanded, and once the
   * panel is PORTALLED there is no DOM relationship left for a reader to infer one from either.
   *
   * A DISCLOSURE, deliberately not `role="menu"`. These are navigation links, not commands, and the
   * menu role is a contract - it promises arrow-key roving focus, Home/End, and typeahead, none of
   * which exist here. Claiming it would announce an interaction model the component does not honour,
   * which is worse for a screen-reader user than the plain, accurate one.
   */
  const panelId = $props.id();

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

  /**
   * Escape closes, and focus goes back to the button that opened it.
   *
   * The backdrop already covers a mouse, but a keyboard user who opened this has no pointer to click
   * "outside" with - and once portalled, the panel is not a DOM descendant of the button either, so
   * tabbing out of it does not return anywhere near where they started.
   */
  function handleKeydown(e: KeyboardEvent) {
    if (!open || e.key !== 'Escape') return;
    e.preventDefault();
    open = false;
    buttonEl?.focus();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="shrink-0">
  <button
    bind:this={buttonEl}
    type="button"
    onclick={() => (open = !open)}
    aria-expanded={open}
    aria-controls={panelId}
    class="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-bold transition-colors
    {active
      ? 'bg-cn-yellow text-cn-ink shadow-sm'
      : 'border-cn-border text-text-muted hover:text-text-main border'}"
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
      class="fixed inset-0 z-190"
      onclick={() => (open = false)}
    ></div>
    <div
      bind:this={panelEl}
      id={panelId}
      use:portal
      class="bg-cn-surface/95 fixed z-200 min-w-52 space-y-0.5 rounded-2xl border border-black/8 p-1.5 shadow-lg backdrop-blur-xl dark:border-white/10"
    >
      {#each items as item (item.href)}
        <a
          href={item.href}
          onclick={() => (open = false)}
          class="text-text-main hover:bg-cn-yellow/15 flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition-colors"
        >
          <item.icon size={15} />
          {item.label}
        </a>
      {/each}
    </div>
  {/if}
</div>
