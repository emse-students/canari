/// <reference types="jest" />

import {
  buildPushDataFields,
  buildApnsRequest,
  partitionTokensByPlatform,
  PushMessageInput,
} from './push-payload';

const baseInput: PushMessageInput = {
  groupId: 'group-1',
  queuedMessageId: 'queued-9',
  senderId: 'user-sender',
  senderName: 'Alice',
  groupName: 'Asso BDE',
  proto: 'AAEC',
  silent: false,
  isWelcome: false,
  createdAt: '2026-06-17T10:00:00.000Z',
};

describe('buildPushDataFields', () => {
  it('serialises every value as a string (FCM requirement)', () => {
    const data = buildPushDataFields(baseInput);
    expect(data).toEqual({
      type: 'message',
      groupId: 'group-1',
      queuedMessageId: 'queued-9',
      senderId: 'user-sender',
      senderName: 'Alice',
      groupName: 'Asso BDE',
      proto: 'AAEC',
      silent: 'false',
      isWelcome: 'false',
      createdAt: '2026-06-17T10:00:00.000Z',
    });
    for (const v of Object.values(data)) expect(typeof v).toBe('string');
  });

  it('maps booleans to "true"/"false"', () => {
    const data = buildPushDataFields({
      ...baseInput,
      silent: true,
      isWelcome: true,
    });
    expect(data.silent).toBe('true');
    expect(data.isWelcome).toBe('true');
  });
});

describe('buildApnsRequest', () => {
  it('builds a mutable-content alert for visible messages', () => {
    const data = buildPushDataFields(baseInput);
    const req = buildApnsRequest(baseInput, data);

    expect(req.pushType).toBe('alert');
    expect(req.priority).toBe(10);
    const aps = req.payload.aps as Record<string, unknown>;
    expect(aps['mutable-content']).toBe(1);
    expect(aps['thread-id']).toBe('group-1');
    expect((aps.alert as { title: string }).title).toBe('Alice');
    // Custom keys are siblings of aps so the NSE can read them.
    expect(req.payload.queuedMessageId).toBe('queued-9');
    expect(req.payload.proto).toBe('AAEC');
  });

  it('falls back to the group name then "Canari" for the alert title', () => {
    const noSender = buildApnsRequest(
      { ...baseInput, senderName: '' },
      buildPushDataFields({ ...baseInput, senderName: '' }),
    );
    expect(
      (
        (noSender.payload.aps as Record<string, unknown>).alert as {
          title: string;
        }
      ).title,
    ).toBe('Asso BDE');

    const anonymous = buildApnsRequest(
      { ...baseInput, senderName: '', groupName: '' },
      buildPushDataFields({ ...baseInput, senderName: '', groupName: '' }),
    );
    expect(
      (
        (anonymous.payload.aps as Record<string, unknown>).alert as {
          title: string;
        }
      ).title,
    ).toBe('Canari');
  });

  it('builds a silent background push with no alert', () => {
    const input = { ...baseInput, silent: true };
    const req = buildApnsRequest(input, buildPushDataFields(input));

    expect(req.pushType).toBe('background');
    expect(req.priority).toBe(5);
    const aps = req.payload.aps as Record<string, unknown>;
    expect(aps['content-available']).toBe(1);
    expect(aps.alert).toBeUndefined();
  });
});

describe('partitionTokensByPlatform', () => {
  it('splits tokens into android and ios buckets', () => {
    const tokens = [
      { platform: 'android' as const, token: 'a1' },
      { platform: 'ios' as const, token: 'i1' },
      { platform: 'android' as const, token: 'a2' },
    ];
    const { android, ios } = partitionTokensByPlatform(tokens);
    expect(android.map((t) => t.token)).toEqual(['a1', 'a2']);
    expect(ios.map((t) => t.token)).toEqual(['i1']);
  });

  it('returns empty buckets for no tokens', () => {
    expect(partitionTokensByPlatform([])).toEqual({ android: [], ios: [] });
  });
});
