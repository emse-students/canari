import { VOIP_RING_KEYS, voipRingPayload } from './call-ring-payload';

describe('voipRingPayload', () => {
  const payload = voipRingPayload({
    groupId: 'group-1',
    callId: 'call-1',
    callerId: 'caller',
    ringUntilMs: 1_700_000_060_000.7,
  });

  it('carries ids and the deadline, and no other key', () => {
    expect(Object.keys(payload).sort()).toEqual([...VOIP_RING_KEYS].sort());
    expect(payload).toEqual({
      type: 'call_ring',
      groupId: 'group-1',
      callId: 'call-1',
      callerId: 'caller',
      hasVideo: 'false',
      ringUntil: '1700000060000',
    });
  });

  it('never names the caller or the conversation (decision 6)', () => {
    for (const key of ['callerName', 'senderName', 'groupName']) {
      expect(payload).not.toHaveProperty(key);
    }
  });
});
