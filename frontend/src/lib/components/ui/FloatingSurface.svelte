<script lang="ts">
  import type { Snippet } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { portal } from '$lib/actions/portal';
  import { clickOutside } from '$lib/actions/clickOutside';
  import { bindFixedPopover } from '$lib/actions/fixedPopover';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE SURFACE AN IN-APP CONTROL OPENS: a sheet rising from the bottom on a phone, a popover under
   * its trigger on a wider window - shared by `Picker` and `DateTimeField`, which differ only in
   * what they put inside it.
   *
   * WHY IT EXISTS (user, 2026-09-29): native `<select>` and date inputs open the SYSTEM's dialogs on
   * Android. Replacing them means every replacement needs the same shell - portalled to the body so
   * no transformed ancestor can trap it, stacked at `--z-modal-popover` because the ones that matter
   * open from inside a modal, dismissed by a tap outside, Escape stopped at the panel so it never
   * reaches that modal's own window-level Escape. Written twice, those rules drift.
   *
   * Only the sheet is a `dialog`: it is modal, with a backdrop. The popover leaves the page usable
   * around it, so it is a labelled `group`, never a dialog that claims otherwise.
   *
   * The CALLER decides the shape when it opens (`asSheet`), by `SHEET_QUERY`, so a control never
   * changes shape under the finger that opened it.
   */
  interface Props {
    /** Whether the surface is shown. The caller owns it and closes it through `onClose`. */
    open: boolean;
    /** Sheet (phone) or popover (wide window), decided by the caller at open time. */
    asSheet: boolean;
    /** The control that opened it: the popover's anchor, and never an "outside" click. */
    anchor: HTMLElement | null;
    /** Names the surface for assistive technology and titles the sheet. */
    label: string;
    /** Asked to close: a tap outside, the backdrop, or Escape (`refocus` = return to the anchor). */
    onClose: (refocus: boolean) => void;
    /** Popover width: `anchor` matches the trigger's width at least, `content` sizes to itself. */
    popoverWidth?: 'anchor' | 'content';
    children: Snippet;
    /** Drawn under the scrolling content, outside it - a sheet's actions. */
    footer?: Snippet;
  }

  let {
    open,
    asSheet,
    anchor,
    label,
    onClose,
    popoverWidth = 'anchor',
    children,
    footer,
  }: Props = $props();

  let panelEl: HTMLDivElement | null = $state(null);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    // Stopped here so a modal's window-level Escape never sees it: this closes the surface only.
    e.stopPropagation();
    e.preventDefault();
    onClose(true);
  }

  // Escape bubbles up from whatever holds focus inside the panel - an option, a day, a button -
  // so it is caught on the panel itself, in both shapes, rather than on each control.
  $effect(() => {
    if (!open || !panelEl) return;
    const panel = panelEl;
    panel.addEventListener('keydown', handleKeydown);
    return () => panel.removeEventListener('keydown', handleKeydown);
  });

  $effect(() => {
    if (!open || asSheet || !panelEl || !anchor) return;
    if (popoverWidth === 'anchor') panelEl.style.minWidth = `${anchor.offsetWidth}px`;
    return bindFixedPopover(panelEl, { anchor: () => anchor, offset: 4, estimatedHeight: 420 });
  });
</script>

{#if open && asSheet}
  <div use:portal class="fixed inset-0 z-(--z-modal-popover)">
    <button
      type="button"
      class="absolute inset-0 cursor-default bg-black/45 outline-none"
      aria-label={m.common_close_label()}
      tabindex="-1"
      onclick={() => onClose(true)}
      transition:fade={{ duration: 150 }}
    ></button>
    <div
      bind:this={panelEl}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabindex="-1"
      class="bg-surface-elevated absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl pb-[max(0.5rem,var(--safe-area-inset-bottom,0px))] shadow-2xl"
      transition:fly={{ y: 32, duration: 200 }}
    >
      <div class="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-black/15 dark:bg-white/20"></div>
      <p class="text-text-main shrink-0 px-5 pt-3 pb-2 text-base font-bold">{label}</p>
      <div class="min-h-0 overflow-y-auto overscroll-contain px-2">
        {@render children()}
      </div>
      {#if footer}
        <div class="shrink-0 px-4 pt-2">{@render footer()}</div>
      {/if}
    </div>
  </div>
{:else if open}
  <div
    bind:this={panelEl}
    use:portal
    use:clickOutside={{ enabled: open, callback: () => onClose(false), ignore: () => anchor }}
    role="group"
    aria-label={label}
    tabindex="-1"
    class="bg-surface-elevated border-cn-border fixed z-(--z-modal-popover) flex flex-col overflow-hidden rounded-xl border shadow-lg {popoverWidth ===
    'content'
      ? 'w-max'
      : 'w-max max-w-[min(22rem,calc(100vw-1rem))]'}"
    transition:fade={{ duration: 120 }}
  >
    <div class="min-h-0 overflow-y-auto overscroll-contain p-1.5">
      {@render children()}
    </div>
    {#if footer}
      <div class="border-cn-border shrink-0 border-t px-2 py-2">{@render footer()}</div>
    {/if}
  </div>
{/if}
