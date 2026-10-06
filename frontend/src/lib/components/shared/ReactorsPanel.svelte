<script lang="ts">
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import { portal } from '$lib/actions/portal';
  import { bindFixedPopover } from '$lib/actions/fixedPopover';
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
    return bindFixedPopover(panelEl, { anchor: () => anchor, offset: 6, estimatedHeight: 200 });
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
    class="bg-cn-tooltip text-2xs fixed z-(--z-tooltip) max-w-56 min-w-40 rounded-xl px-3 py-2.5 font-medium text-white shadow-xl"
    role="tooltip"
    {id}
  >
    <p class="text-2xs mb-1.5 font-bold tracking-wide text-white/60 uppercase">
      <EmojiText text={emoji} />{#if label}&nbsp;{label}{/if}
    </p>
    {#if names.size > 0}
      <ul class="space-y-0.5">
        {#each userIds as id (id)}
          <li class="truncate"><EmojiText text={names.get(id) ?? id} /></li>
        {/each}
      </ul>
    {:else}
      <p class="italic opacity-60">{m.common_loading_label()}</p>
    {/if}
  </div>
{/if}
