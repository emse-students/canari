/**
 * Pending call-accept intent (WP-XP-5).
 *
 * When the user answers an incoming call from a SYSTEM surface - the Android CallStyle
 * notification (deep link `?acceptCall=`) or the iOS CallKit UI (native
 * `pending_call_accept.json`, drained via the `read_and_clear_pending_call_accept` Tauri
 * command) - the WebRTC/MLS stack is not ready yet: the app may still be locked behind the
 * PIN and the MLS invite only arrives once the WS connects. This module holds that intent
 * until `CallService.handleCallSignal` sees the matching invite and auto-accepts.
 */
import { appendLog } from '$lib/stores/globalChatSingleton.svelte';

export interface PendingCallAccept {
  groupId: string;
  callId: string;
  hasVideo: boolean;
  /** Epoch ms when the user answered; stale intents are dropped (call long gone). */
  acceptedAt: number;
}

/** An answer older than this is ignored - the caller has long hung up. */
const MAX_PENDING_AGE_MS = 2 * 60_000;

let pending: PendingCallAccept | null = null;

/** Records an accept intent (from a deep link or the native CallKit handler). */
export function setPendingCallAccept(intent: PendingCallAccept): void {
  pending = intent;
  appendLog(`[CallAccept] pending accept recorded call=${intent.callId}`);
}

/**
 * Consumes the pending intent if it matches `callId` (and is fresh). Returns null and keeps
 * nothing on mismatch/expiry - a stale intent must never auto-accept a DIFFERENT call.
 */
export function consumePendingCallAccept(callId: string): PendingCallAccept | null {
  if (!pending) return null;
  if (Date.now() - pending.acceptedAt > MAX_PENDING_AGE_MS) {
    appendLog('[CallAccept] pending accept expired - dropped');
    pending = null;
    return null;
  }
  if (pending.callId !== callId) return null;
  const intent = pending;
  pending = null;
  return intent;
}

/**
 * Drains the native iOS CallKit accept file (written by `performAnswerCallAction` while the
 * webview may not even be running) into the in-memory intent. Call at startup and on resume;
 * no-op outside Tauri or when nothing is pending.
 */
export async function drainNativePendingCallAccept(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const raw = await invoke<string | null>('read_and_clear_pending_call_accept');
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<PendingCallAccept>;
    if (!parsed.groupId || !parsed.callId) return;
    setPendingCallAccept({
      groupId: parsed.groupId,
      callId: parsed.callId,
      hasVideo: !!parsed.hasVideo,
      acceptedAt: typeof parsed.acceptedAt === 'number' ? parsed.acceptedAt : Date.now(),
    });
  } catch {
    // Non-Tauri runtime or malformed file: nothing to drain.
  }
}
