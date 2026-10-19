<script lang="ts">
  /**
   * Stands in for `CameraOverlay` in the composer tests: it records what the composer handed the
   * camera, and its button publishes "a reel filmed from the composer" as the real overlay would.
   */
  import { cameraOverlayStub } from './cameraOverlayStub.test-helper';

  let {
    destination,
    composerCaption,
    composerIdentity,
    onpublished,
    onclose,
  }: {
    destination: string;
    composerCaption?: string;
    composerIdentity?: string;
    onpublished?: (identity: string) => void;
    onclose: () => void;
  } = $props();

  $effect(() => {
    cameraOverlayStub.last = { destination, composerCaption, composerIdentity };
  });
</script>

<button
  type="button"
  data-camera-overlay-stub-publish
  onclick={() => {
    onpublished?.(composerIdentity ?? '');
    onclose();
  }}>publish</button
>
