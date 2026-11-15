import { getContext, setContext } from 'svelte';

/**
 * THE MODERATION READ OF A REPLAY (lead, 2026-11-14, docs/wiki/profiles-and-access.md): the
 * reported-content preview names the post it is judging, and a replay page under it asks the server
 * for that replay with `?moderation=true`. Carried as a Svelte context rather than a prop through
 * PostContent, ReelViewer and ReelSlide, and keyed by post id, so a further reel the viewer may page
 * on to is read as any viewer reads it.
 */
const KEY = Symbol('moderation-read');

/** Declares, for the component subtree, the post the moderation preview is judging. */
export function provideModerationRead(postId: () => string | null): void {
  setContext(KEY, postId);
}

/** Whether `postId` is the post a moderation preview above this component is judging. */
export function isModerationRead(postId: string): boolean {
  const judged = getContext<(() => string | null) | undefined>(KEY);
  return judged !== undefined && judged() === postId;
}
