import { describe, expect, it } from 'vitest';
import { deviceAskDetail } from './joinRequestAnswer';
import type { JoinRequest } from './joinRequests.svelte';

const deviceAsk = (deviceLabel?: string): JoinRequest => ({
  groupId: 'g1',
  userId: 'peer',
  deviceIds: ['d1'],
  kind: 'device',
  keyFingerprint: 'a1b2c3d4e5f60718',
  ...(deviceLabel === undefined ? {} : { deviceLabel }),
});

describe('deviceAskDetail - the key first, the server-given name after it', () => {
  it('names the key in groups of four before the name', () => {
    const line = deviceAskDetail(deviceAsk('Pixel'));
    expect(line).not.toBeNull();
    expect(line!.indexOf('a1b2 c3d4 e5f6 0718')).toBeLessThan(line!.indexOf('Pixel'));
  });

  it('cuts a long name, so it cannot carry a key of its own past the real one', () => {
    const line = deviceAskDetail(deviceAsk(`x${'k'.repeat(80)}`))!;
    expect(line).toContain('...');
    expect(line.length).toBeLessThan(90);
  });

  it('says unnamed for a blank name, and nothing for an ask that is not a device', () => {
    expect(deviceAskDetail(deviceAsk('   '))).toContain('a1b2 c3d4');
    expect(
      deviceAskDetail({ groupId: 'g1', userId: 'peer', deviceIds: ['d1'] } as JoinRequest)
    ).toBeNull();
  });
});
