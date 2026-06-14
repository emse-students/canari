const PENDING_ACK_STORAGE_KEY = 'canari_pending_message_acks';
const ACK_BACKOFF_MS = [500, 2000, 5000] as const;

interface PendingAckPayload {
  userId: string;
  deviceId: string;
  messageIds: string[];
}

/** Reads persisted ACK ids from sessionStorage (survives reload). */
export function readPersistedPendingAcks(): PendingAckPayload | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(PENDING_ACK_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PendingAckPayload;
  } catch {
    return null;
  }
}

function persistPendingAcks(payload: PendingAckPayload | null): void {
  if (typeof sessionStorage === 'undefined') return;
  if (!payload || payload.messageIds.length === 0) {
    sessionStorage.removeItem(PENDING_ACK_STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(PENDING_ACK_STORAGE_KEY, JSON.stringify(payload));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POSTs message ACKs with exponential backoff; persists failed ids for the next session.
 */
export async function ackMessagesWithRetry(
  historyUrl: string,
  headers: Record<string, string>,
  body: PendingAckPayload,
  log?: (msg: string) => void
): Promise<void> {
  const persisted = readPersistedPendingAcks();
  const messageIds = [...new Set([...(persisted?.messageIds ?? []), ...body.messageIds])];
  if (messageIds.length === 0) return;

  const payload: PendingAckPayload = {
    userId: body.userId,
    deviceId: body.deviceId,
    messageIds,
  };

  for (let attempt = 0; attempt <= ACK_BACKOFF_MS.length; attempt++) {
    try {
      const res = await fetch(`${historyUrl}/api/mls/messages/ack`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      });
      if (res.ok) {
        persistPendingAcks(null);
        log?.(`[ACK] ${messageIds.length} message(s) acknowledged`);
        return;
      }
      log?.(`[ACK] HTTP ${res.status} attempt ${attempt + 1}`);
    } catch (e) {
      log?.(`[ACK] failed attempt ${attempt + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (attempt < ACK_BACKOFF_MS.length) {
      await sleep(ACK_BACKOFF_MS[attempt]);
    }
  }

  persistPendingAcks(payload);
  log?.(`[ACK] ${messageIds.length} id(s) persisted for retry on next connect`);
}
