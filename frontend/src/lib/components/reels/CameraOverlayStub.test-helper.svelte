<script lang="ts">
  /**
   * Stands in for `CameraOverlay` in the composer tests: it records what the composer handed the
   * camera, and its buttons do what the real overlay would at the end of a reel publish step -
   * publish the reel.
   */
  import { cameraOverlayStub } from './cameraOverlayStub.test-helper';
  import type { ComposerReelState } from '$lib/posts/composerReelState';

  let {
    destination,
    composerStart,
    oncapture,
    onpublished,
    onclose,
  }: {
    destination: string;
    composerStart?: ComposerReelState;
    oncapture: (file: File) => void;
    onpublished?: (identity: string) => void;
    onclose: () => void;
  } = $props();

  $effect(() => {
    cameraOverlayStub.last = { destination, composerStart };
  });
</script>

<button
  type="button"
  data-camera-overlay-stub-publish
  onclick={() => {
    onpublished?.(composerStart?.identity ?? '');
    onclose();
  }}>publish</button
>
