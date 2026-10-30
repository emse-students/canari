import { showToast, showUndoToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';
import {
  answerJoinRequest,
  isOwnDeviceAsk,
  pendingJoinRequests,
  type JoinRequest,
} from './joinRequests.svelte';
import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
import { undoMemberDeviceDecline } from './memberDeviceAnswers';

/**
 * A member's answer to a new person asking to join, from the line the ask is drawn as in its
 * conversation (`JoinRequestRow`). One path, so a failed answer always says the same thing: the ask stays on screen and a toast tells the
 * member it did not go through (`answerJoinRequest` names why in the log).
 *
 * A DECLINED UNSEEN DEVICE (`kind: 'device'`) is offered an Undo: the decline holds for the session
 * in that conversation, and undoing it has the next sweep ask again (`undoMemberDeviceDecline`).
 *
 * @returns whether the answer went through.
 */
export async function answerJoinRequestOrToast(
  request: JoinRequest,
  choice: 'approve' | 'decline'
): Promise<boolean> {
  const done = await answerJoinRequest(request, choice);
  if (!done) {
    showToast(m.join_request_failed(), 'error');
    return false;
  }
  const [deviceId] = request.deviceIds;
  if (choice === 'decline' && request.kind === 'device' && deviceId !== undefined) {
    showUndoToast(m.join_request_device_declined(), () =>
      undoMemberDeviceDecline(request.groupId, request.userId, deviceId)
    );
  }
  return true;
}

/** The longest device name a device ask shows; past it the name is cut. */
const MAX_DEVICE_LABEL = 32;

/**
 * The second line of a device ask (`kind: 'device'`): the fingerprint of its key, in groups of four -
 * the key the approval binds, so the member approves THIS key and a later package under another one
 * is asked about anew - then the name its account gave it. The name is the server's, a hint only: it
 * comes AFTER the key, quoted and cut, so a name cannot pose as the key the line names first.
 * `null` for any other ask.
 */
export function deviceAskDetail(request: JoinRequest): string | null {
  if (request.kind !== 'device' || !request.keyFingerprint) return null;
  const fingerprint = request.keyFingerprint.match(/.{1,4}/g)?.join(' ') ?? request.keyFingerprint;
  const label = request.deviceLabel?.trim();
  return label
    ? m.join_request_device_detail({
        label: label.length > MAX_DEVICE_LABEL ? `${label.slice(0, MAX_DEVICE_LABEL)}...` : label,
        fingerprint,
      })
    : m.join_request_device_detail_unnamed({ fingerprint });
}

/**
 * The conversation-list preview while an ask awaits a member in this conversation, or `null`. The
 * same words as the line in the thread (`JoinRequestRow`), so the list says what the thread will.
 * Display only: no badge, no unread change, no notification (owner, 2026-10-30). Reactive - it reads
 * the ask store - so the ordinary preview returns once the ask is answered.
 */
export function pendingAskPreview(
  groupId: string,
  myUserId: string | null | undefined
): string | null {
  const ask = pendingJoinRequests().find((r) => r.groupId === groupId);
  if (!ask) return null;
  const user = getUserDisplayNameSync(ask.userId);
  if (ask.kind !== 'device') return m.join_request_row_text({ user });
  return isOwnDeviceAsk(ask, myUserId)
    ? m.join_request_device_row_text_own()
    : m.join_request_device_row_text({ user });
}
