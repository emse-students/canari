<script lang="ts">
  /**
   * Stands in for `CameraOverlay` in the composer tests: it records what the composer handed the
   * camera, and its buttons do what the real overlay would at the end of a reel publish step -
   * publish the reel, or keep the video as a post with the step's caption and identity.
   */
  import { cameraOverlayStub } from './cameraOverlayStub.test-helper';

  let {
    destination,
    composerCaption,
    composerIdentity,
    oncapture,
    onpublished,
    onkept,
    onclose,
  }: {
    destination: string;
    composerCaption?: string;
    composerIdentity?: string;
    oncapture: (file: File) => void;
    onpublished?: (identity: string) => void;
    onkept?: (caption: string, identity: string) => void;
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
<button
  type="button"
  data-camera-overlay-stub-keep
  onclick={() => {
    const { caption, identity } = cameraOverlayStub.keepWith ?? {
      caption: composerCaption ?? '',
      identity: composerIdentity ?? '',
    };
    onkept?.(caption, identity);
    oncapture(new File(['take'], 'canari-video-1.webm', { type: 'video/webm' }));
    onclose();
  }}>keep</button
>
