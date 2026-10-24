<script lang="ts">
  /**
   * The in-app camera as a FULL-SCREEN LAYER over the page that asked for it - a conversation or the
   * new-post composer (user, 2026-10-11, D-camera: no native camera, this one is the only capture path).
   *
   * AN OVERLAY, NEVER THE `/camera` TAB (reels-in-chat.md section 1): a conversation is selected by
   * state, not by a route a Back can restore, so leaving through the tab would drop the draft, the
   * scroll position and the open conversation. The layer is moved to `document.body` (a composer sits
   * under transforms that would turn `fixed` into "fixed to the composer") and holds ONE history entry:
   * Back closes the camera when nothing is being taken, while a take pushes its own above it
   * (ReelCapture), so Back ends a recording, then discards a review, then closes the camera.
   *
   * THE PAGE UNDER IT IS NOT TOUCHED. It used to set `fullscreen-place-open` as the tab's route does,
   * but that class re-lays the page OUT (the shell's top padding, the scroller's bottom padding and
   * `overflow: hidden`): under an opaque layer it changed nothing visible, and a scroller at its
   * bottom lost its padding, so its `scrollTop` was clamped and the conversation or the feed came back
   * shifted (PR #1859 review, 2026-10-15). The layer is `fixed` on `document.body`, outside the shell,
   * so none of those rules ever applied to IT.
   *
   * IT DOES COVER THE SCREEN, AND SAYS SO (`coversScreen`). On iOS the conversation's chrome and the
   * tab bar are NATIVE views drawn above the whole WebView, which no `z-index` reaches: the back
   * button, the title pill, the menu and the composer's "+" painted over the viewfinder (iPhone 12,
   * 1.2.9-alpha.1, 2026-10-15). They hide while a surface is registered there, as under every modal -
   * the post composer's camera was clean only because its modal already was one.
   *
   * THE LEFT-EDGE SWIPE IS ITS BACK TOO. The iOS app has no system Back: its only one is the swipe the
   * conversation draws (`swipeBack`), and this layer is portalled OUT of the conversation, so a swipe
   * over the review reached nothing (iPhone 12, v1.2.9-alpha.2, 2 of 2). The layer carries the same
   * gesture, and it closes the TOP overlay - the take first (which asks), then the camera.
   *
   * THERE IS NO FALLBACK. A camera that cannot open (permission, no device) shows its own refusal
   * screen in CameraScreen; the member closes the layer and uses the gallery picker.
   */
  import { onDestroy, onMount } from 'svelte';
  import ReelCapture from './ReelCapture.svelte';
  import { m } from '$lib/paraglide/messages';
  import { portal } from '$lib/actions/portal';
  import { coversScreen } from '$lib/actions/coversScreen.svelte';
  import type { CaptureDestination } from '$lib/reels/reelCapture';
  import {
    abandonHistoryOverlay,
    armHistoryOverlayGesture,
    backHistoryOverlayFromGesture,
    type HistoryGestureArm,
    isMobileOverlayLayout,
    pushHistoryOverlay,
  } from '$lib/utils/historyOverlayStack';
  import { swipeBack } from '$lib/actions/swipeBack';
  import type { CameraSession } from '$lib/reels/cameraSession.svelte';

  interface Props {
    /** The composer asking: decides what the camera may take and where the take goes. */
    destination: Exclude<CaptureDestination, 'feed'>;
    /** The take, as a file for the composer's ordinary attachment path. */
    oncapture: (file: File) => void;
    /** The layer asks to be unmounted (the X, Back, or after a take was handed back). */
    onclose: () => void;
    /** The session, injectable for tests. */
    session?: CameraSession;
    /** The new-post composer's text and identity, the start of a reel filmed from it (`post`). */
    composerCaption?: string;
    composerIdentity?: string;
    /** A reel filmed from the new-post composer was published (`post`). */
    onpublished?: (identity: string) => void;
    /** "Garder comme post": the publish step's caption and identity, back to the composer. */
    onkept?: (caption: string, identity: string) => void;
    /** A `chat` camera that may film a reel message (`chatReelWriter.ts`); photos only otherwise. */
    chatFilms?: boolean;
  }

  let {
    destination,
    oncapture,
    onclose,
    session,
    composerCaption,
    composerIdentity,
    onpublished,
    onkept,
    chatFilms = false,
  }: Props = $props();

  /**
   * Where the overlay stack holds entries (`isMobileOverlayLayout`) - the one predicate the swipe and
   * the entries share, so a swipe never closes an entry the layout does not stand behind. Read once:
   * the layer lives for one take.
   */
  const narrow = isMobileOverlayLayout();

  const entry = () => {
    console.debug(`[camera-overlay] Back closes the camera (${destination})`);
    onclose();
  };

  onMount(() => {
    console.debug(`[camera-overlay] open for ${destination}`);
    // The composer's text field may still hold the focus (a tap on a menu item does not take it on
    // iOS), and a focused field keeps the soft keyboard up OVER the shutter. The layer takes it down.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== document.body) {
      console.debug('[camera-overlay] the focused field is blurred: no keyboard over the camera');
      focused.blur();
    }
    pushHistoryOverlay(entry);
  });

  /** The stack's top when the swipe's finger came down: one swipe closes at most that layer. */
  let gestureArm: HistoryGestureArm | null = null;

  onDestroy(() => {
    // A no-op when Back already took the entry off the stack.
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
  class="fixed inset-0 z-(--z-viewer) bg-black text-white"
  role="dialog"
  aria-modal="true"
  aria-label={m.chat_attach_menu_camera()}
  data-camera-overlay={destination}
>
  <ReelCapture
    {session}
    {destination}
    {oncapture}
    {onclose}
    {composerCaption}
    {composerIdentity}
    {onpublished}
    {onkept}
    {chatFilms}
  />
</div>
