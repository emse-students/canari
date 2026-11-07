<script lang="ts">
  /**
   * Stands in for `CameraOverlay` in the composer tests: it records what the composer handed the
   * camera, and its buttons do what the real overlay would at the end of a reel publish step -
   * publish the reel, or keep the video as a post with the step's caption and identity.
   */
  import { cameraOverlayStub } from './cameraOverlayStub.test-helper';
  import { EMPTY_COMPOSER_REEL_STATE, type ComposerReelState } from '$lib/posts/composerReelState';

  let {
    destination,
    composerStart,
    oncapture,
    onpublished,
    onkept,
    onclose,
  }: {
    destination: string;
    composerStart?: ComposerReelState;
    oncapture: (file: File) => void;
    onpublished?: (identity: string) => void;
    onkept?: (kept: ComposerReelState) => void;
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
<button
  type="button"
  data-camera-overlay-stub-keep
  onclick={() => {
    onkept?.(cameraOverlayStub.keepWith ?? composerStart ?? EMPTY_COMPOSER_REEL_STATE);
    oncapture(new File(['take'], 'canari-video-1.webm', { type: 'video/webm' }));
    onclose();
  }}>keep</button
>
