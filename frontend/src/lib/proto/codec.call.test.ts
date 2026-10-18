import { mkCallAnswered, mkCallInvite } from '$lib/proto/codec';

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
