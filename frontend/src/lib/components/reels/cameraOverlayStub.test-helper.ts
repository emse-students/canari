/**
 * The `CameraOverlayStub` control panel for the composer tests: what the composer last handed the
 * camera, and the caption and identity its "keep" button reports (`null`: as the composer gave them).
 */
export const cameraOverlayStub: {
  last: { destination: string; composerCaption?: string; composerIdentity?: string } | null;
  keepWith: { caption: string; identity: string } | null;
} = { last: null, keepWith: null };
