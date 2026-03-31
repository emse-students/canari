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

  const controlMsg = encodeAppMessage(mkSystem('groupRenamed', JSON.stringify({ newName })));
  await mlsService.sendMessage(groupId, controlMsg);
  const stBytes = await mlsService.saveState(pin);
  localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));
}

export async function deleteGroupAndBroadcast(params: {
  mlsService: IMlsService;
  groupId: string;
}) {
  const { mlsService, groupId } = params;

  const controlMsg = encodeAppMessage(mkSystem('groupDeleted'));
  try {
    await mlsService.sendMessage(groupId, controlMsg);
  } catch {
    // Best effort broadcast
  }

  await mlsService.deleteGroupOnServer(groupId);
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
  const controlMsg = encodeAppMessage(
    mkSystem('memberRemoved', JSON.stringify({ targetUser: memberId }))
  );
  await mlsService.sendMessage(groupId, controlMsg);

  // 3. Remove from the server-side member registry.
  await mlsService.removeMemberFromServer(groupId, memberId);

  const stBytes = await mlsService.saveState(pin);
  localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));
}
