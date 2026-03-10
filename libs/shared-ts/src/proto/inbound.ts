import * as base64 from 'base64-js';

export interface InboundMsgPayload {
  ciphertext: Uint8Array;
  senderId: string;
  senderDeviceId: string;
  groupId: string;
  isWelcome: boolean;
}

/**
 * Build a Redis routing envelope as flat JSON — no protobuf encoding.
 * Shape: { recipientId, deviceId, senderId, senderDeviceId, groupId, isWelcome, proto: base64(ciphertext) }
 *
 * The gateway Redis subscriber expects this exact shape and forwards it
 * verbatim (minus the routing fields) to the target WebSocket client.
 */
export function encodeInboundMsgEnvelope(
  recipientId: string,
  deviceId: string,
  payload: InboundMsgPayload
): string {
  return JSON.stringify({
    recipientId,
    deviceId,
    senderId: payload.senderId,
    senderDeviceId: payload.senderDeviceId,
    groupId: payload.groupId,
    isWelcome: payload.isWelcome,
    proto: base64.fromByteArray(payload.ciphertext as Uint8Array),
  });
}
