import type { ComposerReelState } from '$lib/posts/composerReelState';

/**
 * The `CameraOverlayStub` control panel for the composer tests: what the composer last handed the
 * camera, and the state its "keep" button reports (`null`: as the composer gave it).
 */
export const cameraOverlayStub: {
  last: { destination: string; composerStart?: ComposerReelState } | null;
  keepWith: ComposerReelState | null;
} = { last: null, keepWith: null };
