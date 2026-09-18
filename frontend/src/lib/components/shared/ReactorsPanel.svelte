<script lang="ts">
  import { portal } from '$lib/actions/portal';
  import { clickOutside } from '$lib/actions/clickOutside';
  import { bindFixedPopover } from '$lib/actions/fixedPopover';
  import { userDisplayNames } from '$lib/utils/users/displayNames.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The badge the panel belongs to - its anchor, and the click that must never dismiss it. */
    anchor: HTMLElement | null;
    /** The reaction being named. `null` closes the panel. */
    emoji: string | null;
    /** Label under the emoji - the reaction's own name where it has one. */
    label?: string;
    /** Everyone who reacted with it. */
    userIds: string[];
    /** Called when the reader dismisses the panel, by any of the four ways below. */
    onClose: () => void;
  }

  let { anchor, emoji, label, userIds, onClose }: Props = $props();

  let panelEl = $state<HTMLElement | null>(null);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

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

  $effect(() => () => {
    if (hideTimer) clearTimeout(hideTimer);
  });

  function close() {
    cancelHide();
    onClose();
  }

  /**
   * THE GRACE PERIOD LIVES HERE BECAUSE OTHERWISE BOTH CALLERS WOULD CARRY IT.
   *
   * A pointer leaving the badge is on its way to the panel as often as it is leaving for good, and
   * the two are told apart only by what happens next - so the badge's `mouseleave` SCHEDULES a close
   * that the panel's own `mouseenter` cancels. Exported rather than inferred: the badge is the
   * caller's element, this component never sees its events.
   */
  export function scheduleHide() {
    cancelHide();
    hideTimer = setTimeout(close, 120);
  }

  function cancelHide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape' && emoji) close();
  }}
/>

<!--
  FOUR WAYS OUT, BECAUSE A FINGER SENDS NO `mouseleave`.
  The posts panel opened on `mouseenter` and closed only on `mouseleave`, so the panel a touch had
  opened simply stayed - which reads like a scroll defect and is a DISMISSAL defect. A tap outside
  and `Escape` close it now; the pointer leaving still does too, for a pointer that has one.

  `ignore` names the badge, and it removes a race rather than timing around it: the tap that OPENS
  the panel is itself an outside click, so whether the control worked at all would depend on whether
  the panel had rendered in between. A behaviour that depends on a frame is not a behaviour.

  `top`/`left` are written by `bindFixedPopover` and never here.
-->
{#if emoji}
  <div
    use:portal
    bind:this={panelEl}
    use:clickOutside={{ enabled: true, callback: close, ignore: () => anchor }}
    class="bg-cn-tooltip text-2xs pointer-events-auto fixed z-(--z-tooltip) max-w-56 min-w-40 rounded-xl px-3 py-2.5 font-medium text-white shadow-xl"
    role="tooltip"
    onmouseenter={cancelHide}
    onmouseleave={scheduleHide}
  >
    <p class="text-2xs mb-1.5 font-bold tracking-wide text-white/60 uppercase">
      {emoji}{#if label}&nbsp;{label}{/if}
    </p>
    {#if names.size > 0}
      <ul class="space-y-0.5">
        {#each userIds as id (id)}
          <li class="truncate">{names.get(id) ?? id}</li>
        {/each}
      </ul>
    {:else}
      <p class="italic opacity-60">{m.common_loading_label()}</p>
    {/if}
  </div>
{/if}
