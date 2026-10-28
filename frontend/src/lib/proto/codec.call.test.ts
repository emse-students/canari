import {
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
