import * as path from 'path';
import * as protobuf from 'protobufjs';
import * as base64 from 'base64-js';

// Resolve the .proto file relative to this package regardless of CWD.
const PROTO_PATH = path.resolve(__dirname, '../../../../libs/proto/canari.proto');

let _InboundMsg: protobuf.Type | null = null;

async function getInboundMsgType(): Promise<protobuf.Type> {
  if (_InboundMsg) return _InboundMsg;
  const root = await protobuf.load(PROTO_PATH);
  _InboundMsg = root.lookupType('canari.InboundMsg');
  return _InboundMsg;
}

export interface InboundMsgPayload {
  ciphertext: Uint8Array;
  senderId: string;
  senderDeviceId: string;
  groupId: string;
  isWelcome: boolean;
}

/**
 * Encode an InboundMsg proto and return a Redis routing envelope:
 *   { recipientId, deviceId, proto: "<base64 InboundMsg>" }
 *
 * This matches the format the chat-gateway Redis subscriber already expects.
 */
export async function encodeInboundMsgEnvelope(
  recipientId: string,
  deviceId: string,
  payload: InboundMsgPayload,
): Promise<string> {
  const type = await getInboundMsgType();
  const msg = type.create({
    ciphertext: payload.ciphertext,
    senderId: payload.senderId,
    senderDeviceId: payload.senderDeviceId,
    groupId: payload.groupId,
    isWelcome: payload.isWelcome,
  });
  const bytes = type.encode(msg).finish();
  const proto = base64.fromByteArray(bytes as Uint8Array);
  return JSON.stringify({ recipientId, deviceId, proto });
}
