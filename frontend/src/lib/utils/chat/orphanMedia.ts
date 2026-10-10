import type { MediaRef } from '$lib/media';

/**
 * Whether MY attachment could be an orphan: its reference has no `mediaId` (the placeholder the
 * sender writes BEFORE the upload, `useMessaging` `handleSendChat`) and no live upload view or
 * terminal upload failure explains it. Only a candidate: the verdict needs the durable queue
 * (`isOutboxEntryQueued`), because `status` is derived in memory and says nothing after a reload.
 *
 * OWN ROWS ONLY: a receiver cannot know the sender's outbox state, and a sender uploads before it
 * sends, so a received empty-`mediaId` row has no producer in the current code.
 */
export function isOrphanMediaCandidate(input: {
  mediaRef: MediaRef | null | undefined;
  isOwn: boolean;
  hasUpload: boolean;
  uploadFailed: boolean;
}): boolean {
  return (
    input.isOwn &&
    !!input.mediaRef &&
    !input.mediaRef.mediaId &&
    !input.hasUpload &&
    !input.uploadFailed
  );
}
