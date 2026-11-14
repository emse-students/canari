import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import {
  asGroupCallSignal,
  callEndReasonFromWire,
  decodeAppMessage,
  encodeAppMessage,
  mkCallAnswered,
  mkCallBusy,
  mkCallHangup,
  mkCallInvite,
} from '$lib/proto/codec';

describe('call multi-device codec', () => {
  it('mkCallInvite includes device id and the server ring window', () => {
    const msg = mkCallInvite('room-1', true, 'device-a', 60_000);
    expect(msg.call?.callId).toBe('room-1');
    expect(msg.call?.deviceId).toBe('device-a');
    expect(msg.call?.ringTimeoutMs).toBe(60_000);
    expect(msg.call?.offerSdp).toBe('START');
  });

  it('mkCallAnswered signals sibling dismiss', () => {
    const msg = mkCallAnswered('room-1', 'device-b');
    expect(msg.call?.callId).toBe('room-1');
    expect(msg.call?.deviceId).toBe('device-b');
    expect(msg.call?.answered).toBe(true);
  });
});

describe('call end reason and busy answer (B15, B16)', () => {
  it('carries the typed reason on a hangup, and none on an ordinary one', () => {
    for (const reason of ['cancelled', 'declined', 'not-answered', 'busy'] as const) {
      const wire = mkCallHangup('room-1', 'device-a', reason).call?.endReason;
      expect(callEndReasonFromWire(wire)).toBe(reason);
    }
    const plain = mkCallHangup('room-1', 'device-a');
    expect(plain.call?.hangup).toBe(true);
    expect(callEndReasonFromWire(plain.call?.endReason)).toBeUndefined();
  });

  it('survives encoding, and an old hangup decodes with no reason', () => {
    const decoded = decodeAppMessage(encodeAppMessage(mkCallHangup('r', 'd', 'declined')));
    expect(callEndReasonFromWire(decoded?.call?.endReason)).toBe('declined');
    const old = decodeAppMessage(encodeAppMessage({ call: { callId: 'r', hangup: true } }));
    expect(callEndReasonFromWire(old?.call?.endReason)).toBeUndefined();
  });

  it('mkCallBusy is its own payload, never a hangup', () => {
    const msg = mkCallBusy('room-1', 'device-b');
    expect(msg.call?.busy).toBe(true);
    expect(msg.call?.hangup).toBeFalsy();
    const decoded = decodeAppMessage(encodeAppMessage(msg));
    expect(decoded?.call?.busy).toBe(true);
  });
});

describe('a group call signal is a kind an older build does not know (WP-GC2)', () => {
  /** `AppMessage` as a build before group calls compiled it: the schema minus field 15. */
  function appMessageBeforeGroupCalls(): protobuf.Type {
    const path = fileURLToPath(new URL('../../../../libs/proto/canari.proto', import.meta.url));
    const text = readFileSync(path, 'utf8');
    const withoutGroupCall = text
      .split(/\r?\n/)
      .filter((line) => !/^\s*CallMsg\s+group_call\s*=\s*15;/.test(line))
      .join('\n');
    // The field's comment names it too: what matters is that no FIELD is declared.
    expect(withoutGroupCall).not.toMatch(/group_call\s*=/);
    return protobuf.parse(withoutGroupCall).root.lookupType('canari.AppMessage');
  }

  it('travels as group_call, never as call', () => {
    const msg = asGroupCallSignal(mkCallInvite('room-1', false, 'device-a', 60_000));
    expect(msg.call).toBeUndefined();
    const decoded = decodeAppMessage(encodeAppMessage(msg));
    expect(decoded?.call).toBeFalsy();
    expect(decoded?.groupCall?.callId).toBe('room-1');
    expect(decoded?.groupCall?.offerSdp).toBe('START');
  });

  it('decodes on an older build as a message with NO kind, so nothing there can ring', () => {
    const bytes = encodeAppMessage(
      asGroupCallSignal(mkCallInvite('room-1', true, 'device-a', 60_000))
    );
    const old = appMessageBeforeGroupCalls().toObject(
      appMessageBeforeGroupCalls().decode(bytes),
      { oneofs: true }
    ) as Record<string, unknown>;
    // The invite is gone: no `call` (what an old build's invite test reads), and no kind at all.
    expect(old.call).toBeUndefined();
    expect(old.kind).toBeUndefined();
    // The same schema still reads a 1:1 invite: the test is the kind, not a broken parser.
    const direct = appMessageBeforeGroupCalls().toObject(
      appMessageBeforeGroupCalls().decode(encodeAppMessage(mkCallInvite('room-2', true, 'd', 1))),
      { oneofs: true }
    ) as Record<string, unknown>;
    expect(direct.kind).toBe('call');
  });

  it('leaves a message that is not a call signal untouched', () => {
    const text = { text: { content: 'hello' } };
    expect(asGroupCallSignal(text)).toBe(text);
  });
});
