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

  await mlsService.removeMemberFromServer(groupId, memberId);
  const controlMsg = encodeAppMessage(
    mkSystem('memberRemoved', JSON.stringify({ targetUser: memberId }))
  );
  await mlsService.sendMessage(groupId, controlMsg);
  const stBytes = await mlsService.saveState(pin);
  localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));
}
