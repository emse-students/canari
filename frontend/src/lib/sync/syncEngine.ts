import type { ConversationMeta, EncryptedMessageRow, IStorage, StoredMessage } from '$lib/db';
import { fromBase64, toBase64 } from '$lib/utils/hex';
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

/** Trims and lower-cases an ID so all lookups are case-insensitive. */
function normalizeConversationId(id: string): string {
  return id.trim().toLowerCase();
}

/** Comparator that sorts messages by timestamp, breaking ties with the message ID. */
function byTimestampThenId(a: StoredMessage, b: StoredMessage): number {
  if (a.timestamp === b.timestamp) return a.id.localeCompare(b.id);
  return a.timestamp - b.timestamp;
}

/**
 * Encodes a raw conversation ID as a URL-safe base64 string prefixed with `cid_`
 * so it can be safely embedded in JSON and query parameters.
 */
function encodeConversationTransportId(rawId: string): string {
  const utf8 = new TextEncoder().encode(rawId);
  return `cid_${toBase64(utf8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

/**
 * Reverses `encodeConversationTransportId`. Returns the original ID unchanged if
 * the `cid_` prefix is absent (backwards-compatible with unencoded IDs).
 */
function decodeConversationTransportId(transportId: string): string {
  if (!transportId.startsWith('cid_')) return transportId;
  const body = transportId.slice(4);
  const padded = body
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(body.length / 4) * 4, '=');
  const bytes = fromBase64(padded);
  return new TextDecoder().decode(bytes);
}

/**
 * Reads the `canari_ws_token` cookie set by the auth flow and used to
 * authenticate WebSocket and sync API requests.
 */
function getWsSessionToken(): string | null {
  if (typeof document === 'undefined') return null;
  const cookies = document.cookie ? document.cookie.split(';') : [];
  for (const rawCookie of cookies) {
    const cookie = rawCookie.trim();
    if (!cookie.startsWith('canari_ws_token=')) continue;
    const token = decodeURIComponent(cookie.slice('canari_ws_token='.length));
    return token && token.trim() ? token : null;
  }
  return null;
}

/**
 * Builds a headers object that includes an `Authorization: Bearer …` header
 * when a session token is available, merged with any `extra` headers provided.
 */
function withAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getWsSessionToken();
  return token ? { Authorization: `Bearer ${token}`, ...extra } : { ...extra };
}

/**
 * Reads all conversations and their messages from the local encrypted DB and
 * produces a manifest snapshot. Message IDs are sorted by timestamp so the diff
 * algorithm can detect gaps without transferring full content.
 */
export async function buildLocalSyncManifest(
  storage: IStorage,
  pin: string
): Promise<SyncManifestPayload> {
  const conversations = await storage.getConversations();
  const items = await Promise.all(
    conversations.map(async (conv) => {
      const normalizedId = normalizeConversationId(conv.id);
      const messages = await storage.getMessages(normalizedId, pin);
      messages.sort(byTimestampThenId);
      return {
        conversationId: encodeConversationTransportId(normalizedId),
        groupId: conv.id,
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

/**
 * Computes the symmetric difference between two manifests entirely in the
 * browser (no server round-trip). Returns the list of conversations/messages
 * that each side is missing so both devices know exactly what to upload or
 * request. Conversations present on only one side are included with an empty
 * `messageIds` array so the metadata is still synchronised.
 */
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

    // Ensure metadata-only conversations are still synchronized.
    if (localConv && !remoteConv) {
      missingOnPeer.push({
        conversationId,
        groupId: localConv.groupId,
        updatedAt: localConv.updatedAt,
        messageIds: [],
      });
      continue;
    }

    if (!localConv && remoteConv) {
      missingOnRequester.push({
        conversationId,
        groupId: remoteConv.groupId,
        updatedAt: remoteConv.updatedAt,
        messageIds: [],
      });
      continue;
    }

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

/**
 * Loads the actual encrypted rows from local storage for each message ID listed
 * in `missingOnPeer` and groups them by conversation, ready for upload. Rows
 * that no longer exist in storage (e.g. deleted) are silently skipped.
 */
export async function buildTransferChunksForMissing(
  storage: IStorage,
  _manifest: SyncManifestPayload,
  missingOnPeer: SyncDiffResponse['missingOnPeer']
): Promise<SyncTransferChunk[]> {
  const conversations = await storage.getConversations();
  const conversationByEncodedId = new Map(
    conversations.map((c) => [encodeConversationTransportId(normalizeConversationId(c.id)), c])
  );
  const encryptedRows = await storage.getAllEncryptedRows();
  const rowById = new Map(encryptedRows.map((row) => [row.id, row]));

  const fallbackConversation = (conversationId: string): ConversationMeta => {
    const decoded = normalizeConversationId(decodeConversationTransportId(conversationId));
    return {
      id: decoded,
      name: decoded,
      isReady: false,
      updatedAt: Date.now(),
    };
  };

  return missingOnPeer
    .map((entry) => {
      const rows: EncryptedMessageRow[] = entry.messageIds
        .map((id) => rowById.get(id))
        .filter((row): row is EncryptedMessageRow => Boolean(row));

      const conversation =
        conversationByEncodedId.get(entry.conversationId) ??
        fallbackConversation(entry.conversationId);

      return {
        conversation,
        rows,
      };
    })
    .filter((chunk): chunk is SyncTransferChunk => Boolean(chunk));
}

/** Encodes a Uint8Array as a standard base64 string for JSON transport. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decodes a standard base64 string back to a Uint8Array. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Converts in-memory transfer chunks (with Uint8Array fields) to the JSON-safe
 * wire format, encoding conversation IDs and binary fields as base64 strings.
 */
function serializeChunks(chunks: SyncTransferChunk[]): SyncSerializedChunk[] {
  return chunks.map((chunk) => ({
    conversation: {
      ...chunk.conversation,
      id: encodeConversationTransportId(normalizeConversationId(chunk.conversation.id)),
      groupId: normalizeConversationId(chunk.conversation.id),
    },
    rows: chunk.rows.map((row) => ({
      id: row.id,
      conversationId: encodeConversationTransportId(normalizeConversationId(row.conversationId)),
      timestamp: row.timestamp,
      iv: bytesToBase64(row.iv),
      salt: bytesToBase64(row.salt),
      cipherText: bytesToBase64(row.cipherText),
    })),
  }));
}

/**
 * Reverses `serializeChunks`: decodes conversation IDs and converts base64
 * strings back to Uint8Arrays, producing in-memory transfer chunks.
 */
function deserializeChunks(chunks: SyncSerializedChunk[]): SyncTransferChunk[] {
  return chunks.map((chunk) => ({
    conversation: {
      ...chunk.conversation,
      id: normalizeConversationId(decodeConversationTransportId(chunk.conversation.id)),
    },
    rows: chunk.rows.map((row) => ({
      id: row.id,
      conversationId: normalizeConversationId(decodeConversationTransportId(row.conversationId)),
      timestamp: row.timestamp,
      iv: base64ToBytes(row.iv),
      salt: base64ToBytes(row.salt),
      cipherText: base64ToBytes(row.cipherText),
    })),
  }));
}

/** Generates `bytes` random bytes and returns them as a URL-safe base64 string. */
function randomBase64Url(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  const b64 = btoa(String.fromCharCode(...data));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Generates a random 32-byte ephemeral public key token for ECDH session pairing.
 * Returns a URL-safe base64 string.
 */
export function generateEphemeralPublicKey(): string {
  // Placeholder opaque key token for session pairing; crypto channel hardening comes next.
  return randomBase64Url(32);
}

/** Serialises a QR payload object to a JSON string for encoding into the QR image. */
export function encodeSyncQrPayload(payload: SyncQrPayload): string {
  return JSON.stringify(payload);
}

/**
 * Parses and validates the raw JSON string scanned from a sync QR code.
 * Throws if any required field (`sessionId`, `joinToken`, `userId`) is missing or not a string.
 */
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

/**
 * Polls the server for the current state of a sync session.
 * The initiating device calls this repeatedly until `state === 'joined'`.
 */
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
    `${historyBaseUrl}/api/mls/sync/session/${encodeURIComponent(payload.sessionId)}?${qs.toString()}`,
    { method: 'GET', headers: withAuthHeaders() }
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

/** Sends an authenticated POST request with a JSON body and returns the parsed response. */
async function postJson<TResponse>(url: string, body: unknown): Promise<TResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: withAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `Sync request failed (${response.status})`);
  }

  return (await response.json()) as TResponse;
}

/** Creates a new sync session on the server and returns the session details including the QR payload. */
export async function startSyncSession(
  historyBaseUrl: string,
  req: SyncStartSessionRequest
): Promise<SyncStartSessionResponse> {
  return postJson<SyncStartSessionResponse>(`${historyBaseUrl}/api/mls/sync/session/start`, req);
}

/**
 * Registers the joining device with an existing session.
 * Called after the second device scans the QR code.
 */
export async function joinSyncSession(
  historyBaseUrl: string,
  req: SyncJoinSessionRequest
): Promise<{ state: 'joined'; offerDeviceId: string; offerPublicKey: string; expiresAt: number }> {
  return postJson(`${historyBaseUrl}/api/mls/sync/session/join`, req);
}

/**
 * Uploads this device's conversation manifest to the server so both sides
 * can compute the diff once the peer has also uploaded theirs.
 */
export async function uploadSyncManifest(
  historyBaseUrl: string,
  payload: {
    sessionId: string;
    userId: string;
    deviceId: string;
    manifest: SyncManifestPayload;
  }
): Promise<{ status: string; conversations: number; generatedAt: number }> {
  return postJson(`${historyBaseUrl}/api/mls/sync/session/manifest`, payload);
}

/**
 * Asks the server to compute the diff between both devices' manifests.
 * Fails with "Both manifests must be uploaded" if the peer has not yet uploaded theirs.
 */
export async function requestSyncDiff(
  historyBaseUrl: string,
  payload: { sessionId: string; userId: string; deviceId: string }
): Promise<SyncDiffResponse> {
  return postJson<SyncDiffResponse>(`${historyBaseUrl}/api/mls/sync/session/diff`, payload);
}

/** Maximum number of conversations per upload request to keep payloads small. */
const SYNC_UPLOAD_BATCH_SIZE = 20;

/**
 * Uploads serialised message chunks to the server in batches of `SYNC_UPLOAD_BATCH_SIZE`
 * conversations so that no single request exceeds the body-size limit regardless of
 * how many messages the user has.
 */
export async function uploadSyncChunks(
  historyBaseUrl: string,
  payload: UploadSyncChunksRequest
): Promise<{ status: string; chunkCount: number; rowCount: number }> {
  const { chunks, ...basePayload } = payload;

  if (chunks.length === 0) {
    return { status: 'stored', chunkCount: 0, rowCount: 0 };
  }

  let totalChunks = 0;
  let totalRows = 0;

  for (let i = 0; i < chunks.length; i += SYNC_UPLOAD_BATCH_SIZE) {
    const batch = chunks.slice(i, i + SYNC_UPLOAD_BATCH_SIZE);
    const result = await postJson<{ status: string; chunkCount: number; rowCount: number }>(
      `${historyBaseUrl}/api/mls/sync/session/chunks/upload`,
      { ...basePayload, chunks: batch }
    );
    totalChunks += result.chunkCount;
    totalRows += result.rowCount;
  }

  return { status: 'stored', chunkCount: totalChunks, rowCount: totalRows };
}

/** Downloads the message chunks that the peer device uploaded for this device. */
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
    `${historyBaseUrl}/api/mls/sync/session/${encodeURIComponent(payload.sessionId)}/chunks/pull?${qs.toString()}`,
    { method: 'GET', headers: withAuthHeaders() }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `Sync chunk pull failed (${response.status})`);
  }
  return (await response.json()) as PullSyncChunksResponse;
}

/**
 * Writes the chunks received from the peer device into the local encrypted DB.
 * Existing conversations are merged (upserted) and duplicate message IDs are skipped.
 * Returns the number of new conversations and messages actually written.
 */
export async function applyIncomingSyncChunks(
  storage: IStorage,
  chunks: SyncTransferChunk[]
): Promise<{ importedConversationCount: number; importedMessageCount: number }> {
  const importedConversationIds = new Set<string>();
  let importedMessages = 0;
  const importedMessageIds = new Set<string>();

  for (const chunk of chunks) {
    const normalizedConversationId = normalizeConversationId(chunk.conversation.id);
    await storage.mergeConversation({
      ...chunk.conversation,
      id: normalizedConversationId,
    });
    importedConversationIds.add(normalizedConversationId);

    for (const row of chunk.rows) {
      const normalizedRow = {
        ...row,
        conversationId: normalizeConversationId(row.conversationId),
      };
      await storage.importEncryptedRow(normalizedRow);
      if (!importedMessageIds.has(normalizedRow.id)) {
        importedMessageIds.add(normalizedRow.id);
        importedMessages++;
      }
    }
  }

  return {
    importedConversationCount: importedConversationIds.size,
    importedMessageCount: importedMessages,
  };
}

/**
 * Polls `requestSyncDiff` with exponential-free retries until both devices have
 * uploaded their manifests. Retries only on the "Both manifests must be uploaded"
 * error; any other error is re-thrown immediately.
 */
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

/**
 * Runs a complete bidirectional sync round for one device:
 * 1. Builds and uploads the local manifest.
 * 2. Waits for the peer to upload theirs, then requests the server-side diff.
 * 3. Uploads the messages the peer is missing.
 * 4. Pulls and applies the messages this device is missing.
 *
 * Returns counts of uploaded and imported messages plus the raw diff object.
 */
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
