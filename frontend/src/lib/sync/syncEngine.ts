import type { ConversationMeta, EncryptedMessageRow, IStorage, StoredMessage } from '$lib/db';
import type {
  SyncDiffResponse,
  SyncJoinSessionRequest,
  SyncManifestPayload,
  SyncStartSessionRequest,
  SyncStartSessionResponse,
  SyncTransferChunk,
} from '$lib/sync/types';

function byTimestampThenId(a: StoredMessage, b: StoredMessage): number {
  if (a.timestamp === b.timestamp) return a.id.localeCompare(b.id);
  return a.timestamp - b.timestamp;
}

export async function buildLocalSyncManifest(
  storage: IStorage,
  pin: string
): Promise<SyncManifestPayload> {
  const conversations = await storage.getConversations();
  const items = await Promise.all(
    conversations.map(async (conv) => {
      const messages = await storage.getMessages(conv.id, pin);
      messages.sort(byTimestampThenId);
      return {
        conversationId: conv.id,
        groupId: conv.groupId,
        updatedAt: conv.updatedAt,
        messageIds: messages.map((m) => m.id),
      };
    })
  );

  return {
    generatedAt: Date.now(),
    conversations: items,
  };
}

export function diffLocalAndRemoteManifest(
  local: SyncManifestPayload,
  remote: SyncManifestPayload
): Pick<SyncDiffResponse, 'missingOnRequester' | 'missingOnPeer'> {
  const localByConversation = new Map(local.conversations.map((c) => [c.conversationId, c]));
  const remoteByConversation = new Map(remote.conversations.map((c) => [c.conversationId, c]));

  const allConversationIds = new Set<string>([
    ...localByConversation.keys(),
    ...remoteByConversation.keys(),
  ]);

  const missingOnRequester: SyncDiffResponse['missingOnRequester'] = [];
  const missingOnPeer: SyncDiffResponse['missingOnPeer'] = [];

  for (const conversationId of allConversationIds) {
    const localConv = localByConversation.get(conversationId);
    const remoteConv = remoteByConversation.get(conversationId);

    const localIds = new Set(localConv?.messageIds ?? []);
    const remoteIds = new Set(remoteConv?.messageIds ?? []);

    const requesterMissing = [...remoteIds].filter((id) => !localIds.has(id));
    if (requesterMissing.length > 0) {
      missingOnRequester.push({
        conversationId,
        groupId: localConv?.groupId ?? remoteConv?.groupId,
        updatedAt: localConv?.updatedAt ?? remoteConv?.updatedAt,
        messageIds: requesterMissing,
      });
    }

    const peerMissing = [...localIds].filter((id) => !remoteIds.has(id));
    if (peerMissing.length > 0) {
      missingOnPeer.push({
        conversationId,
        groupId: localConv?.groupId ?? remoteConv?.groupId,
        updatedAt: localConv?.updatedAt ?? remoteConv?.updatedAt,
        messageIds: peerMissing,
      });
    }
  }

  return { missingOnRequester, missingOnPeer };
}

export async function buildTransferChunksForMissing(
  storage: IStorage,
  manifest: SyncManifestPayload,
  missingOnPeer: SyncDiffResponse['missingOnPeer']
): Promise<SyncTransferChunk[]> {
  const conversations = await storage.getConversations();
  const conversationById = new Map(conversations.map((c) => [c.id, c]));
  const encryptedRows = await storage.getAllEncryptedRows();
  const rowById = new Map(encryptedRows.map((row) => [row.id, row]));

  const fallbackConversation = (conversationId: string): ConversationMeta => ({
    id: conversationId,
    groupId: conversationId,
    name: conversationId,
    isReady: false,
    updatedAt: Date.now(),
  });

  return missingOnPeer
    .map((entry) => {
      const rows: EncryptedMessageRow[] = entry.messageIds
        .map((id) => rowById.get(id))
        .filter((row): row is EncryptedMessageRow => Boolean(row));
      if (rows.length === 0) return null;

      const conversation =
        conversationById.get(entry.conversationId) ?? fallbackConversation(entry.conversationId);

      return {
        conversation,
        rows,
      };
    })
    .filter((chunk): chunk is SyncTransferChunk => Boolean(chunk));
}

async function postJson<TResponse>(url: string, body: unknown): Promise<TResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `Sync request failed (${response.status})`);
  }

  return (await response.json()) as TResponse;
}

export async function startSyncSession(
  historyBaseUrl: string,
  req: SyncStartSessionRequest
): Promise<SyncStartSessionResponse> {
  return postJson<SyncStartSessionResponse>(`${historyBaseUrl}/mls-api/sync/session/start`, req);
}

export async function joinSyncSession(
  historyBaseUrl: string,
  req: SyncJoinSessionRequest
): Promise<{ state: 'joined'; offerDeviceId: string; offerPublicKey: string; expiresAt: number }> {
  return postJson(`${historyBaseUrl}/mls-api/sync/session/join`, req);
}

export async function uploadSyncManifest(
  historyBaseUrl: string,
  payload: {
    sessionId: string;
    userId: string;
    deviceId: string;
    manifest: SyncManifestPayload;
  }
): Promise<{ status: string; conversations: number; generatedAt: number }> {
  return postJson(`${historyBaseUrl}/mls-api/sync/session/manifest`, payload);
}

export async function requestSyncDiff(
  historyBaseUrl: string,
  payload: { sessionId: string; userId: string; deviceId: string }
): Promise<SyncDiffResponse> {
  return postJson<SyncDiffResponse>(`${historyBaseUrl}/mls-api/sync/session/diff`, payload);
}
