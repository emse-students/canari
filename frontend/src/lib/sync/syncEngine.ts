import type { ConversationMeta, EncryptedMessageRow, IStorage, StoredMessage } from '$lib/db';
import type {
  SyncDiffResponse,
  SyncJoinSessionRequest,
  SyncManifestPayload,
  PullSyncChunksResponse,
  SyncQrPayload,
  SyncSerializedChunk,
  SyncStartSessionRequest,
  SyncStartSessionResponse,
  SyncTransferChunk,
  UploadSyncChunksRequest,
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
  _manifest: SyncManifestPayload,
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

function bytesToArray(bytes: Uint8Array): number[] {
  return Array.from(bytes);
}

function arrayToBytes(input: number[]): Uint8Array {
  return new Uint8Array(input);
}

function serializeChunks(chunks: SyncTransferChunk[]): SyncSerializedChunk[] {
  return chunks.map((chunk) => ({
    conversation: chunk.conversation,
    rows: chunk.rows.map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      timestamp: row.timestamp,
      iv: bytesToArray(row.iv),
      salt: bytesToArray(row.salt),
      cipherText: bytesToArray(row.cipherText),
    })),
  }));
}

function deserializeChunks(chunks: SyncSerializedChunk[]): SyncTransferChunk[] {
  return chunks.map((chunk) => ({
    conversation: chunk.conversation,
    rows: chunk.rows.map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      timestamp: row.timestamp,
      iv: arrayToBytes(row.iv),
      salt: arrayToBytes(row.salt),
      cipherText: arrayToBytes(row.cipherText),
    })),
  }));
}

function randomBase64Url(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  const b64 = btoa(String.fromCharCode(...data));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function generateEphemeralPublicKey(): string {
  // Placeholder opaque key token for session pairing; crypto channel hardening comes next.
  return randomBase64Url(32);
}

export function encodeSyncQrPayload(payload: SyncQrPayload): string {
  return JSON.stringify(payload);
}

export function parseSyncQrPayload(raw: string): SyncQrPayload {
  const parsed = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed.sessionId !== 'string' ||
    typeof parsed.joinToken !== 'string' ||
    typeof parsed.userId !== 'string'
  ) {
    throw new Error('QR sync payload invalide');
  }
  return parsed as SyncQrPayload;
}

export async function getSyncSessionState(
  historyBaseUrl: string,
  payload: { sessionId: string; userId: string }
): Promise<{
  sessionId: string;
  state: 'waiting_join' | 'joined';
  offerDeviceId: string;
  answerDeviceId?: string;
  offerPublicKey: string;
  answerPublicKey?: string;
  expiresAt: number;
}> {
  const qs = new URLSearchParams({ userId: payload.userId });
  const response = await fetch(
    `${historyBaseUrl}/mls-api/sync/session/${encodeURIComponent(payload.sessionId)}?${qs.toString()}`,
    { method: 'GET' }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `Sync state request failed (${response.status})`);
  }
  return (await response.json()) as {
    sessionId: string;
    state: 'waiting_join' | 'joined';
    offerDeviceId: string;
    answerDeviceId?: string;
    offerPublicKey: string;
    answerPublicKey?: string;
    expiresAt: number;
  };
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

export async function uploadSyncChunks(
  historyBaseUrl: string,
  payload: UploadSyncChunksRequest
): Promise<{ status: string; chunkCount: number; rowCount: number }> {
  return postJson(`${historyBaseUrl}/mls-api/sync/session/chunks/upload`, payload);
}

export async function pullSyncChunks(
  historyBaseUrl: string,
  payload: {
    sessionId: string;
    userId: string;
    toDeviceId: string;
    fromDeviceId: string;
  }
): Promise<PullSyncChunksResponse> {
  const qs = new URLSearchParams({
    userId: payload.userId,
    toDeviceId: payload.toDeviceId,
    fromDeviceId: payload.fromDeviceId,
  });
  const response = await fetch(
    `${historyBaseUrl}/mls-api/sync/session/${encodeURIComponent(payload.sessionId)}/chunks/pull?${qs.toString()}`,
    { method: 'GET' }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `Sync chunk pull failed (${response.status})`);
  }
  return (await response.json()) as PullSyncChunksResponse;
}

export async function applyIncomingSyncChunks(
  storage: IStorage,
  chunks: SyncTransferChunk[]
): Promise<{ importedConversationCount: number; importedMessageCount: number }> {
  let importedConversations = 0;
  let importedMessages = 0;

  for (const chunk of chunks) {
    await storage.mergeConversation(chunk.conversation);
    importedConversations++;

    for (const row of chunk.rows) {
      await storage.importEncryptedRow(row);
      importedMessages++;
    }
  }

  return {
    importedConversationCount: importedConversations,
    importedMessageCount: importedMessages,
  };
}

async function waitForDiffReady(
  historyBaseUrl: string,
  payload: { sessionId: string; userId: string; deviceId: string },
  retries = 20,
  delayMs = 500
): Promise<SyncDiffResponse> {
  for (let i = 0; i < retries; i++) {
    try {
      return await requestSyncDiff(historyBaseUrl, payload);
    } catch (error) {
      const message = String(error);
      if (!message.includes('Both manifests must be uploaded')) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('Timeout: manifestes de synchro incomplets');
}

export async function executeBidirectionalSyncRound(params: {
  historyBaseUrl: string;
  storage: IStorage;
  pin: string;
  userId: string;
  myDeviceId: string;
  peerDeviceId: string;
  sessionId: string;
}): Promise<{
  uploadedMessageCount: number;
  importedMessageCount: number;
  diff: SyncDiffResponse;
}> {
  const { historyBaseUrl, storage, pin, userId, myDeviceId, peerDeviceId, sessionId } = params;

  const localManifest = await buildLocalSyncManifest(storage, pin);
  await uploadSyncManifest(historyBaseUrl, {
    sessionId,
    userId,
    deviceId: myDeviceId,
    manifest: localManifest,
  });

  const diff = await waitForDiffReady(historyBaseUrl, {
    sessionId,
    userId,
    deviceId: myDeviceId,
  });

  const outgoingChunks = await buildTransferChunksForMissing(
    storage,
    localManifest,
    diff.missingOnPeer
  );

  await uploadSyncChunks(historyBaseUrl, {
    sessionId,
    userId,
    fromDeviceId: myDeviceId,
    toDeviceId: peerDeviceId,
    chunks: serializeChunks(outgoingChunks),
  });

  const pulled = await pullSyncChunks(historyBaseUrl, {
    sessionId,
    userId,
    toDeviceId: myDeviceId,
    fromDeviceId: peerDeviceId,
  });

  const incomingChunks = deserializeChunks(pulled.chunks);
  const imported = await applyIncomingSyncChunks(storage, incomingChunks);

  return {
    uploadedMessageCount: outgoingChunks.reduce((acc, chunk) => acc + chunk.rows.length, 0),
    importedMessageCount: imported.importedMessageCount,
    diff,
  };
}
