/**
 * The payload of the APNs VoIP push that rings an iPhone through CallKit (WP-C6, the native ring).
 *
 * **It names nobody** (decision 6, 2026-10-18): a VoIP push crosses Apple's servers in clear, so it
 * carries ids and nothing a person typed. The phone writes the caller's name on the CallKit screen
 * from its OWN copy of names (`display_names.json`, keyed by `callerId`), and shows the neutral
 * "Canari call" for a caller it has never named. A `callerName`, `senderName` or `groupName` here
 * would be the exact leak decision 6 removed from every other push.
 *
 * `ringUntil` is the server's own answer deadline (`call:room:<id>:answer_by`, epoch ms): the phone
 * ends its CallKit ring there instead of at a constant of its own, and a push that arrives after it
 * (APNs held it while the phone was off) is reported and ended at once - Apple requires the report
 * either way (`docs/wiki/frontend/modules/calls.md`, "The native ring on the iPhone").
 *
 * Every value is a string: the ObjC reader (`canari_push.mm`, `didReceiveIncomingPushWithPayload`)
 * reads each one as `NSString`, the same convention as the FCM data payload.
 */
export interface VoipRingInput {
  groupId: string;
  callId: string;
  callerId: string;
  /** Epoch milliseconds at which the server stops accepting an answer. */
  ringUntilMs: number;
}

/** The keys a VoIP ring may carry, and no other: pinned by `call-ring-payload.spec.ts`. */
export const VOIP_RING_KEYS = ['type', 'groupId', 'callId', 'callerId', 'hasVideo', 'ringUntil'];

/**
 * Builds the VoIP ring payload. `hasVideo` is always `false`: the native ring is audio-only until
 * the video lot decides how it rings (B2: a ring must never announce a video call an audio-only
 * build would answer as audio).
 */
export function voipRingPayload(input: VoipRingInput): Record<string, string> {
  return {
    type: 'call_ring',
    groupId: input.groupId,
    callId: input.callId,
    callerId: input.callerId,
    hasVideo: 'false',
    ringUntil: String(Math.floor(input.ringUntilMs)),
  };
}
