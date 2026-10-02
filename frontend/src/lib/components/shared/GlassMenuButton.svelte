<script lang="ts" module>
  import type { Component } from 'svelte';

  /** One entry of a {@link GlassMenuButton}'s panel. */
  export interface GlassMenuItem {
    id: string;
    /** Visible label (already localised). */
    label: string;
    icon: Component<Record<string, unknown>>;
    onSelect: () => void;
    /** Drawn as ON - a panel or a search that is currently open. */
    active?: boolean;
  }
</script>

<script lang="ts">
  import { scale } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { clickOutside } from '$lib/actions/clickOutside';
  import { portal } from '$lib/actions/portal';
  import { bindFixedPopover } from '$lib/actions/fixedPopover';
  import { Log } from '$lib/utils/Log';

  /**
   * A ROUND GLASS BUTTON THAT GROWS INTO ITS OPTIONS - the Liquid Glass menu, in CSS (user,
   * 2026-09-30: "a back and menu button that then grows ... to show the other options").
   *
   * Used by the conversation header ("more") and the composer ("+"). The panel grows OUT OF the
   * button's corner - it scales from where the button sits, towards the room the popover helper found
   * (below the header, above the composer) - and closes on a pick, on Escape, or on a tap outside.
   * It is portalled: the button wears `glass-chrome`, whose `backdrop-filter` would otherwise confine
   * a `position: fixed` panel to the button's own box.
   */
  interface Props {
    icon: Component<Record<string, unknown>>;
    /** Accessible name of the button, and its tooltip. */
    label: string;
    items: GlassMenuItem[];
    /** Align the panel's right edge with the button's - the button sits at the right of its row. */
    alignEnd?: boolean;
    /**
     * `plain` draws the same menu WITHOUT glass - an ordinary composer button and an opaque panel -
     * for the website, which keeps its classic chrome (`usesGlassChrome`). One menu, two skins.
     */
    variant?: 'glass' | 'plain';
    /**
     * CONTROLLED MODE: the owner holds whether the menu is open (the composer, whose menu is one state
     * of `composerSurface.ts` beside the GIF panel and the keyboard). Every way the menu asks to
     * close or open is then REPORTED, with its reason, and decided by the owner.
     */
    open?: boolean;
    onOpenChange?: (open: boolean, reason: 'toggle' | 'outside' | 'escape' | 'pick') => void;
    /**
     * The button and its entries never take focus: a press leaves it where it was. The composer's
     * "+" needs it - focus moving onto the button blurs the text field, the phone's keyboard falls,
     * and the composer drops the keyboard's height under a menu that only floats above it (measured on
     * the Mi 9T 2026-10-02: 532 -> 877 -> 532 px through "+" then "Envoyer un GIF").
     */
    keepsFocus?: boolean;
  }

  let {
    icon: Icon,
    label,
    items,
    alignEnd = false,
    variant = 'glass',
    open: controlledOpen,
    onOpenChange,
    keepsFocus = false,
  }: Props = $props();

  /** A press's default action is what moves focus; cancelling it keeps focus where it was. */
  function holdFocus(e: MouseEvent) {
    if (keepsFocus) e.preventDefault();
  }

  const buttonClass = $derived(
    variant === 'glass'
      ? 'glass-chrome ui-icon-button text-text-main rounded-full transition-transform outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95'
      : 'ui-icon-button chat-composer-icon-button'
  );
  const panelSkin = $derived(
    variant === 'glass'
      ? 'glass-chrome rounded-2xl'
      : 'bg-surface-elevated border-cn-border rounded-xl border shadow-lg'
  );

  let ownOpen = $state(false);
  const open = $derived(controlledOpen ?? ownOpen);

  /** The one place the menu's openness changes: reported in controlled mode, held here otherwise. */
  function setOpen(next: boolean, reason: 'toggle' | 'outside' | 'escape' | 'pick') {
    Log.d('GlassMenuButton', `${label}: ${next ? 'open' : 'closed'} (${reason})`);
    if (onOpenChange) onOpenChange(next, reason);
    else ownOpen = next;
  }

  // Escape closes the menu wherever focus is - a tap leaves it on the button, not in the panel.
  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false, 'escape');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  let button: HTMLButtonElement | undefined = $state();
  let panel: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (!open || !panel || !button) return;
    const anchor = button;
    return bindFixedPopover(panel, {
      anchor: () => anchor,
      alignEnd,
      offset: 8,
      stayAnchored: true,
    });
  });

  function toggle() {
    setOpen(!open, 'toggle');
  }

  function pick(item: GlassMenuItem) {
    Log.d('GlassMenuButton', `${label}: ${item.id}`);
    setOpen(false, 'pick');
    item.onSelect();
  }
</script>

<div
  class="shrink-0"
  use:clickOutside={{ enabled: open, callback: () => setOpen(false, 'outside') }}
>
  <button
    bind:this={button}
    type="button"
    onclick={toggle}
    onmousedown={holdFocus}
    aria-label={label}
    title={label}
    aria-haspopup="menu"
    aria-expanded={open}
    class={buttonClass}
  >
    <Icon size={20} strokeWidth={2.25} />
  </button>

  {#if open}
    <div
      bind:this={panel}
      use:portal
      role="menu"
      tabindex="-1"
      class="glass-menu-panel {panelSkin} fixed z-(--z-popover) flex w-max min-w-44 flex-col gap-0.5 p-1.5 {alignEnd
        ? 'glass-menu-end'
        : 'glass-menu-start'}"
      transition:scale={{ duration: 180, start: 0.35, easing: cubicOut }}
    >
      {#each items as item (item.id)}
        {@const ItemIcon = item.icon}
        <button
          type="button"
          role={item.active === undefined ? 'menuitem' : 'menuitemcheckbox'}
          onclick={() => pick(item)}
          onmousedown={holdFocus}
          aria-checked={item.active}
          class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-amber-500/10 {item.active
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-text-main'}"
        >
          <ItemIcon size={18} strokeWidth={2.25} aria-hidden="true" />
          {item.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* The panel GROWS OUT OF the button: its scale origin is the corner that touches the button, on
     whichever side the popover helper opened it (`data-popover-side`). */
  .glass-menu-panel.glass-menu-end:global([data-popover-side='bottom']) {
    transform-origin: top right;
  }
  .glass-menu-panel.glass-menu-end:global([data-popover-side='top']) {
    transform-origin: bottom right;
  }
  .glass-menu-panel.glass-menu-start:global([data-popover-side='bottom']) {
    transform-origin: top left;
  }
  .glass-menu-panel.glass-menu-start:global([data-popover-side='top']) {
    transform-origin: bottom left;
  }
</style>
