import type { MediaRef } from '$lib/media';

/**
 * Whether a message's media reference can never resolve: it carries no `mediaId` (the placeholder
 * the sender writes BEFORE the upload, see `useMessaging` `handleSendChat`) and nothing is
 * advancing it. The caller passes only the refs it has already ruled out as queued - a bubble with
 * a live upload view, or one the outbox ended - so `true` means the file was never uploaded and no
 * entry will ever upload it. The answer comes from the reference itself, never from an error text.
 */
export function isOrphanMediaRef(mediaRef: MediaRef | null | undefined): boolean {
  return !!mediaRef && !mediaRef.mediaId;
}
