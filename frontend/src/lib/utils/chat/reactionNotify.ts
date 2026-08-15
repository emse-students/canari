/**
 * The push that tells a message's author somebody reacted to it.
 *
 * ITS OWN MODULE ON PURPOSE. It lived in `messaging.ts`, which is the outbox side of chatting and
 * drags in the whole chat graph: importing it from `useChannelWorkspaces.svelte.ts` closed the
 * cycle `useChannelWorkspaces -> messaging -> outboxMirror -> globalChatSingleton ->
 * useChannelWorkspaces`, and since the singleton is built at MODULE scope the cycle was entered at
 * import time, not at call time. It broke the whole test file rather than one assertion. This
 * function is a leaf - one authenticated POST - so it belongs where both callers can reach it
 * without pulling anything else in.
 */

import { apiFetch } from '$lib/utils/apiFetch';

/**
 * Notifies the author of a message that the current user reacted to it.
 *
 * IT SENDS AN ID, NEVER A COPY - and it used to send a copy. `messagePreview` carried 80
 * characters of the DECRYPTED message to the server, which built a sentence around them and put
 * that sentence in the FCM data map and in the APNs alert body. So plaintext from an end-to-end
 * encrypted conversation reached this server, Google and Apple on every reaction, three lines
 * under a comment asserting that it did not. The recipient is the message's AUTHOR and therefore
 * already holds the message: `messageId` is enough, and the device renders the reaction against
 * its own copy in its own language.
 *
 * Two callers: a DM reaction (`addReaction`) and a channel reaction
 * (`useChannelWorkspaces.toggleChannelReaction`), which notifies the author and nobody else.
 */
export async function notifyReaction(params: {
  groupId: string;
  targetSenderId: string;
  emoji: string;
  /** The reacted-to message, so the author's devices can find their own copy of it. */
  messageId: string;
  actorName: string;
}): Promise<void> {
  // Only the failure branches speak. A line on entry and a line on success fired on EVERY reaction,
  // said nothing a reader could act on, and were the two most frequent lines in the chat console -
  // the rest of the chat helpers already log failures only. The two warns below stay: a swallowed
  // best-effort call leaves nothing else behind.
  //
  // apiFetch attaches the Bearer token (in memory, never in a cookie) and replays once on 401
  // after refresh. A raw fetch went out without Authorization -> nginx auth_request failed -> 401.
  try {
    const resp = await apiFetch('/api/mls/notify-reaction', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.warn(`[notifyReaction] HTTP error ${resp.status}:`, text.slice(0, 200));
    }
  } catch (e) {
    // Fire-and-forget: an expired session must not surface an error to the caller.
    console.warn(`[notifyReaction] Failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
