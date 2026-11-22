/**
 * WHO WRITES A 1:1 CALL'S RECORD WHEN ITS HANGUP ARRIVES (2026-11-22).
 *
 * A device that was IN the call writes its record from its own facts (`CallService.endCall`, its own
 * `connectedAt`); the signal path (`handleCallSignalForChat`) writes it only on a device that was
 * not. The record therefore no longer depends on whether the relay's `PeerLeft` or the MLS hangup
 * arrives first, nor on the other side's build. A module of its own so the call service and the
 * record writer share one fact without importing each other.
 */
let owner: ((callId: string) => boolean) | null = null;

/** Registered by the call service (`setChatNotifier`); `null` when no service is bound. */
export function setCallRecordOwner(next: ((callId: string) => boolean) | null): void {
  owner = next;
}

/** Whether this device's call service writes `callId`'s record itself. */
export function callRecordOwnedHere(callId: string): boolean {
  return owner?.(callId) ?? false;
}
