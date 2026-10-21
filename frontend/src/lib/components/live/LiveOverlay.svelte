<script lang="ts">
  /**
   * The broadcaster's screen as a FULL-SCREEN LAYER over the composer that opened it (WP-L5) - the
   * shape of the in-app camera's `CameraOverlay`, for the same reasons: portalled to `document.body`
   * (the composer sits under transforms), `coversScreen` (the native iOS chrome hides over it), and
   * ONE history entry, the left-edge swipe being its Back too.
   *
   * BACK NEVER ENDS A LIVE SILENTLY. On air, the entry is taken again and the end is ASKED - the same
   * question as the End button. In the preview or after the end, Back closes the layer. A navigation
   * away (`reason === 'navigation'`) unmounts it, and the unmount ends what is on air.
   */
  import { onDestroy, onMount } from 'svelte';
  import { m } from '$lib/paraglide/messages';
  import { portal } from '$lib/actions/portal';
  import { coversScreen } from '$lib/actions/coversScreen.svelte';
  import { swipeBack } from '$lib/actions/swipeBack';
  import {
    abandonHistoryOverlay,
    armHistoryOverlayGesture,
    backHistoryOverlayFromGesture,
    isMobileOverlayLayout,
    pushHistoryOverlay,
    type HistoryGestureArm,
    type OverlayClose,
  } from '$lib/utils/historyOverlayStack';
  import type { LiveBroadcast } from '$lib/live/liveBroadcast.svelte';
  import LiveBroadcaster from './LiveBroadcaster.svelte';

  interface Props {
    /** Broadcast AS this association, or null for the member. */
    associationId?: string | null;
    associationName?: string | null;
    /** The layer asks to be unmounted. */
    onclose: () => void;
    /** The machine, injectable for tests. */
    broadcast?: LiveBroadcast;
    readBattery?: () => Promise<number | null>;
  }

  let {
    associationId = null,
    associationName = null,
    onclose,
    broadcast,
    readBattery,
  }: Props = $props();

  const narrow = isMobileOverlayLayout();
  let screen = $state<LiveBroadcaster | null>(null);
  let dialog = $state<HTMLDivElement | null>(null);
  let gestureArm: HistoryGestureArm | null = null;

  const entry: OverlayClose = (reason) => {
    if (reason !== 'navigation' && screen?.holdsBack()) {
      // Spent by the Back that reached it: armed again, so a "keep going" leaves Back working.
      console.debug('[live-overlay] Back on air: the end is asked');
      pushHistoryOverlay(entry);
      void screen.confirmEnd();
      return;
    }
    console.debug(`[live-overlay] closed by ${reason ?? 'back'}`);
    onclose();
  };

  onMount(() => {
    console.debug(`[live-overlay] open${associationId ? ` as association ${associationId}` : ''}`);
    // Focus moves INTO the dialog: a screen reader starts reading it, and the keyboard is no longer on
    // the composer button behind the layer.
    dialog?.focus({ preventScroll: true });
    pushHistoryOverlay(entry);
  });

  onDestroy(() => {
    abandonHistoryOverlay(entry);
  });
</script>

<div
  use:portal
  use:coversScreen
  use:swipeBack={{
    onBack: () => {
      const arm = gestureArm;
      gestureArm = null;
      void backHistoryOverlayFromGesture(arm);
    },
    onArm: () => (gestureArm = armHistoryOverlayGesture()),
    enabled: narrow,
  }}
  class="fixed inset-0 z-(--z-viewer) bg-black text-white outline-none"
  role="dialog"
  aria-modal="true"
  tabindex="-1"
  bind:this={dialog}
  aria-label={m.live_overlay_label()}
  data-live-overlay
>
  <LiveBroadcaster
    bind:this={screen}
    {associationId}
    {associationName}
    {broadcast}
    {readBattery}
    {onclose}
  />
</div>
