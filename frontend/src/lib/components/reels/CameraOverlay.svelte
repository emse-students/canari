<script lang="ts">
  /**
   * The in-app camera as a FULL-SCREEN LAYER over the page that asked for it - a conversation or the
   * new-post composer (user, 2026-10-11, D-camera: no native camera, this one is the only capture path).
   *
   * AN OVERLAY, NEVER THE `/camera` TAB (reels-in-chat.md section 1): a conversation is selected by
   * state, not by a route a Back can restore, so leaving through the tab would drop the draft, the
   * scroll position and the open conversation. The layer is moved to `document.body` (a composer sits
   * under transforms that would turn `fixed` into "fixed to the composer"), carries
   * `fullscreen-place-open` on the document as the tab's route does, and holds ONE history entry:
   * Back closes the camera when nothing is being taken, while a take pushes its own above it
   * (ReelCapture), so Back ends a recording, then discards a review, then closes the camera.
   *
   * THERE IS NO FALLBACK. A camera that cannot open (permission, no device) shows its own refusal
   * screen in CameraScreen; the member closes the layer and uses the gallery picker.
   */
  import { onDestroy, onMount } from 'svelte';
  import ReelCapture from './ReelCapture.svelte';
  import { m } from '$lib/paraglide/messages';
  import { portal } from '$lib/actions/portal';
  import type { CaptureDestination } from '$lib/reels/reelCapture';
  import { abandonHistoryOverlay, pushHistoryOverlay } from '$lib/utils/historyOverlayStack';
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
  }

  let { destination, oncapture, onclose, session }: Props = $props();

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
    document.documentElement.classList.add('fullscreen-place-open');
    pushHistoryOverlay(entry);
  });

  onDestroy(() => {
    document.documentElement.classList.remove('fullscreen-place-open');
    // A no-op when Back already took the entry off the stack.
    abandonHistoryOverlay(entry);
  });
</script>

<div
  use:portal
  class="fixed inset-0 z-(--z-viewer) bg-black text-white"
  role="dialog"
  aria-modal="true"
  aria-label={m.chat_attach_menu_camera()}
  data-camera-overlay={destination}
>
  <ReelCapture {session} {destination} {oncapture} {onclose} />
</div>
