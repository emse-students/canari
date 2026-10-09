<script lang="ts">
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import { portal } from '$lib/actions/portal';
  import { bindFixedPopover, POPOVER_MARGIN } from '$lib/actions/fixedPopover';
  import { layoutReactors, type ReactorsLayout } from '$lib/utils/reactorsLayout';
  import { userDisplayNames } from '$lib/utils/users/displayNames.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The badge the panel belongs to - where it is placed. */
    anchor: HTMLElement | null;
    /** The reaction being named. `null` closes the panel. */
    emoji: string | null;
    /** Label under the emoji - the reaction's own name where it has one. */
    label?: string;
    /** Everyone who reacted with it. */
    userIds: string[];
    /** DOM id, so the badge can name the panel in `aria-describedby` while it is open. */
    id?: string;
    /** Called when the panel closes - on the reader's next action, whatever it is. */
    onClose: () => void;
  }

  let { anchor, emoji, label, userIds, id, onClose }: Props = $props();

  let panelEl = $state<HTMLElement | null>(null);

  const names = userDisplayNames(() => (emoji ? userIds : []));

  /**
   * PLACEMENT IS THE SHARED ACTION'S, NEVER THIS COMPONENT'S.
   *
   * The posts panel wrote its own `fixed` coordinates from the badge's rect, read ONCE on hover, and
   * the user met both consequences on 2026-09-18 (*"ca sort de l'ecran et si on scrolle, le panneau
   * ne disparait pas (et ne suit pas le scroll)"*): nothing clamped `left`, so a badge near the
   * right edge put the names off screen - the one thing the panel exists to show - and a scroll
   * moved the card out from under a panel that stayed where it was.
   *
   * `bindFixedPopover` answers both and answered them before that panel was written: it clamps both
   * axes into the viewport, flips above the anchor when there is no room below, and re-applies on
   * `scroll` and `resize`. A component that writes its own coordinates is a popover that will run
   * off the screen.
   */
  $effect(() => {
    if (!emoji || !panelEl || !anchor) return;
    // The viewport is the only cap: the height is the CONTENT's, laid out into the room below.
    return bindFixedPopover(panelEl, {
      anchor: () => anchor,
      offset: 6,
      estimatedHeight: window.innerHeight,
    });
  });

  let listEl = $state<HTMLElement | null>(null);
  /** `null` until measured: every name in one column, which is also what zero geometry gives. */
  let layout = $state<ReactorsLayout | null>(null);

  /** Narrowest column worth drawing, in rem: a name truncated below this says nothing. */
  const MIN_COLUMN_REM = 8;

  /**
   * A POPOVER'S HEIGHT COMES FROM ITS CONTENT, NEVER FROM A CONSTANT (user report 2026-10-09: with
   * 11 reactors the frame ended after the 9th name and the rest spilled over the comment below).
   *
   * The action caps the frame at the room it has (`maxHeight`); this measures how many rows that
   * room holds - the chrome is the list's offset in the frame, the row is a measured `li` -
   * and lays the names out in as many columns as the width allows. What still does not fit becomes
   * one "+K" line. It cannot scroll: any scroll closes the panel.
   */
  $effect(() => {
    const count = userIds.length;
    // Re-measure when a name lands: a longer name can change the columns' width, not the rows.
    void names.size;
    if (!emoji || !panelEl || !listEl) {
      layout = null;
      return;
    }
    const li = listEl.querySelector('li');
    const rowH = li?.offsetHeight ?? 0;
    const maxH = Number.parseFloat(panelEl.style.maxHeight);
    if (!rowH || !Number.isFinite(maxH)) {
      layout = null;
      return;
    }
    const css = getComputedStyle(listEl);
    const rowGap = Number.parseFloat(css.rowGap) || 0;
    const colGap = Number.parseFloat(css.columnGap) || 0;
    const frame = getComputedStyle(panelEl);
    const padX =
      (Number.parseFloat(frame.paddingLeft) || 0) + (Number.parseFloat(frame.paddingRight) || 0);
    // Not `panel.offsetHeight - list.offsetHeight`: the frame is already clamped to `maxHeight`.
    const chromeH = listEl.offsetTop + (Number.parseFloat(frame.paddingBottom) || 0);
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const rowsFit = Math.floor((maxH - chromeH + rowGap) / (rowH + rowGap));
    const colsFit = Math.floor(
      (window.innerWidth - POPOVER_MARGIN * 2 - padX + colGap) / (MIN_COLUMN_REM * rem + colGap)
    );
    layout = layoutReactors(count, rowsFit, colsFit);
  });

  /**
   * THE LIST LIVES UNTIL THE READER'S NEXT ACTION, AND NOT ONE MOMENT LONGER (user, 2026-10-01: *"la
   * liste des gens ayant reagi doit disparaitre des la prochaine action (scroll etc.)"*).
   *
   * It is opened by a HOLD, so the press that opened it is already down when this runs: the next
   * `pointerdown` - anywhere, the badge and the list included - is a new action, and so are a scroll,
   * the wheel, a key and a resize. Capture, because `scroll` does not bubble and the lists scroll in
   * their own containers, and because a control that stops propagation must not keep the list open.
   * It replaces four separate dismissals (a tap outside, `Escape`, a scroll, a mouse leaving after a
   * grace period) that each answered one of these and left the others open.
   */
  $effect(() => {
    if (!emoji) return;
    const events = ['pointerdown', 'scroll', 'wheel', 'keydown', 'resize'] as const;
    for (const type of events)
      window.addEventListener(type, onClose, { capture: true, passive: true });
    return () => {
      for (const type of events) window.removeEventListener(type, onClose, { capture: true });
    };
  });
</script>

<!--
  `top`/`left` are written by `bindFixedPopover` and never here. Nothing in the list is interactive:
  a press on it is the reader's next action like any other, and closes it.
-->
{#if emoji}
  <div
    use:portal
    bind:this={panelEl}
    class="bg-cn-tooltip text-2xs fixed z-(--z-tooltip) max-w-[calc(100vw-1rem)] min-w-40 rounded-xl px-3 py-2.5 font-medium text-white shadow-xl"
    class:max-w-56={!layout || layout.cols === 1}
    role="tooltip"
    {id}
  >
    <p class="text-2xs mb-1.5 font-bold tracking-wide text-white/60 uppercase">
      <EmojiText text={emoji} />{#if label}&nbsp;{label}{/if}
    </p>
    {#if names.size > 0}
      <ul
        bind:this={listEl}
        class="grid gap-x-4 gap-y-0.5"
        style:grid-auto-flow={layout ? 'column' : null}
        style:grid-template-rows={layout ? `repeat(${layout.rows}, auto)` : null}
        style:grid-template-columns={layout
          ? `repeat(${layout.cols}, minmax(0, max-content))`
          : null}
      >
        {#each layout ? userIds.slice(0, layout.shown) : userIds as userId (userId)}
          <li class="truncate"><EmojiText text={names.get(userId) ?? userId} /></li>
        {/each}
        {#if layout && layout.hidden > 0}
          <li class="truncate text-white/60 italic">
            {m.reactors_more_label({ count: layout.hidden })}
          </li>
        {/if}
      </ul>
    {:else}
      <p class="italic opacity-60">{m.common_loading_label()}</p>
    {/if}
  </div>
{/if}
