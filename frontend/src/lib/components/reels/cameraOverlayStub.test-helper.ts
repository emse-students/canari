import type { ComposerReelState } from '$lib/posts/composerReelState';

/**
 * The `CameraOverlayStub` control panel for the composer tests: what the composer last handed the
 * camera.
 */
export const cameraOverlayStub: {
  last: { destination: string; composerStart?: ComposerReelState } | null;
} = { last: null };
