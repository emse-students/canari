import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deviceAskDetail, pendingAskPreview } from './joinRequestAnswer';
import { raiseJoinRequest, resetJoinRequests, type JoinRequest } from './joinRequests.svelte';

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `Name(${id})`,
}));

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

describe('pendingAskPreview - the conversation list says what the thread will', () => {
  beforeEach(() => {
    resetJoinRequests();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('is null while nothing is pending in that conversation', () => {
    raiseJoinRequest({ groupId: 'other', requesterUserId: 'carol', requesterDeviceId: 'd1' });
    expect(pendingAskPreview('g1', 'me')).toBeNull();
  });

  it('names a person asking to join by link', () => {
    raiseJoinRequest({ groupId: 'g1', requesterUserId: 'carol', requesterDeviceId: 'd1' });
    expect(pendingAskPreview('g1', 'me')).toBe(
      'Name(carol) veut rejoindre la conversation par lien'
    );
  });

  it('names an unseen device, and goes back to null once the ask is gone', () => {
    raiseJoinRequest({
      groupId: 'g1',
      requesterUserId: 'dave',
      requesterDeviceId: 'd9',
      kind: 'device',
      keyFingerprint: 'abcd',
    });
    expect(pendingAskPreview('g1', 'me')).toBe('Nouvel appareil de Name(dave)');
    resetJoinRequests();
    expect(pendingAskPreview('g1', 'me')).toBeNull();
  });
});
