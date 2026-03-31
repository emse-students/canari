import { toHex } from '$lib/utils/hex';
import type { IMlsService } from '$lib/mlsService';
import { encodeAppMessage, mkSystem } from '$lib/proto/codec';

export async function fetchUniqueGroupMembers(mlsService: IMlsService, groupId: string) {
  const members = await mlsService.getGroupMembers(groupId);
  return [...new Set(members.map((m) => m.userId))];
}

export async function renameGroupAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  newName: string;
  userId: string;
  pin: string;
}) {
  const { mlsService, groupId, newName, userId, pin } = params;
  await mlsService.renameGroup(groupId, newName);

  // Broadcast the rename notification — best-effort: the local rename is
  // already committed to the server; if the MLS message fails, peers will
  // still see the new name when they next fetch group metadata.
  try {
    const controlMsg = encodeAppMessage(mkSystem('groupRenamed', JSON.stringify({ newName })));
    await mlsService.sendMessage(groupId, controlMsg);
  } catch {
    // Non-blocking: rename already applied server-side
  }
  const stBytes = await mlsService.saveState(pin);
  localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));
}

export async function removeMemberAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
  memberId: string;
  userId: string;
  pin: string;
}) {
  const { mlsService, groupId, memberId, userId, pin } = params;

  // 1. MLS remove commit — removes all devices of the target user from the group
  //    and broadcasts the commit to remaining members so they advance their epoch.
  await mlsService.removeMember(groupId, [memberId]);

  // 2. Notify remaining members via an application-layer system message.
  //    Best-effort: do not abort server cleanup if notification fails.
  try {
    const controlMsg = encodeAppMessage(
      mkSystem('memberRemoved', JSON.stringify({ targetUser: memberId }))
    );
    await mlsService.sendMessage(groupId, controlMsg);
  } catch {
    // Non-blocking: the MLS commit already informed peers of the removal
  }

  // 3. Remove from the server-side member registry.
  //    Best-effort: even if this fails, the MLS tree no longer contains the member.
  try {
    await mlsService.removeMemberFromServer(groupId, memberId);
  } catch {
    // Non-blocking: retry on next sync if needed
  }

  const stBytes = await mlsService.saveState(pin);
  localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));
}
