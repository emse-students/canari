import { describe, expect, it } from 'vitest';
import { liveMlsFrameMessage } from './liveFrame';
import { deliveryMetaOf } from './incomingDelivery';

/** The exact JSON `live_mls_frame` (apps/chat-gateway/src/subscribers.rs) sends a socket. */
function gatewayFrame(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    senderId: 'sender',
    senderDeviceId: 'device',
    groupId: 'group',
    isWelcome: false,
    isCommit: false,
    ratchetTree: null,
    proto: 'AQID',
    queuedMessageId: 'queued',
    addressed: false,
    ...extra,
  };
}

/** What the pipeline reads as `deliveryMeta`, from the frame as `enqueueMessage` would admit it. */
function liveMeta(frame: Record<string, unknown>) {
  const queued = liveMlsFrameMessage(frame);
  if (!queued) throw new Error('the frame was refused');
  return deliveryMetaOf({ ...queued, channel: 'live' });
}

describe('liveMlsFrameMessage', () => {
  it('carries the server acceptance of a live frame as queuedCreatedAt (ISO)', () => {
    const iso = '2026-11-03T21:28:44.123Z';
    expect(liveMeta(gatewayFrame({ createdAt: iso }))?.queuedCreatedAt).toBe(Date.parse(iso));
  });

  it('carries it when the gateway forwards epoch ms', () => {
    expect(liveMeta(gatewayFrame({ createdAt: 1_793_741_324_123 }))?.queuedCreatedAt).toBe(
      1_793_741_324_123
    );
  });

  it('states no server time for a frame that carries none', () => {
    const meta = liveMeta(gatewayFrame());
    expect(meta?.queuedCreatedAt).toBeUndefined();
    expect(meta?.queuedMessageId).toBe('queued');
  });

  it('reads the frame fields once for both sockets', () => {
    const queued = liveMlsFrameMessage(gatewayFrame({ isWelcome: true, addressed: true }));
    expect(queued).toMatchObject({
      senderId: 'sender',
      senderDeviceId: 'device',
      groupId: 'group',
      isWelcome: true,
      isCommit: false,
      addressed: true,
      ratchetTreeBytes: undefined,
    });
    expect(Array.from(queued?.ciphertext ?? [])).toEqual([1, 2, 3]);
  });

  it('refuses a frame with no ciphertext', () => {
    expect(liveMlsFrameMessage(gatewayFrame({ proto: '' }))).toBeNull();
  });
});
