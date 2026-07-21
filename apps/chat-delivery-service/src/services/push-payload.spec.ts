/// <reference types="jest" />

import {
  buildPushDataFields,
  buildApnsRequest,
  buildInternalApnsRequest,
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
      buildPushDataFields({ ...baseInput, senderName: '' })
    );
    expect(
      (
        (noSender.payload.aps as Record<string, unknown>).alert as {
          title: string;
        }
      ).title
    ).toBe('Asso BDE');

    const anonymous = buildApnsRequest(
      { ...baseInput, senderName: '', groupName: '' },
      buildPushDataFields({ ...baseInput, senderName: '', groupName: '' })
    );
    expect(
      (
        (anonymous.payload.aps as Record<string, unknown>).alert as {
          title: string;
        }
      ).title
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

describe('buildInternalApnsRequest', () => {
  it('builds a mutable-content alert for an encrypted channel message', () => {
    const data = {
      type: 'channel',
      channelId: 'chan-42',
      channelName: 'general',
      keyVersion: '3',
      ciphertext: 'Q0lQSA==',
      nonce: 'Tk9OQ0U=',
      senderId: 'user-sender',
    };
    const req = buildInternalApnsRequest('general', '', data);

    expect(req.pushType).toBe('alert');
    expect(req.priority).toBe(10);
    const aps = req.payload.aps as Record<string, unknown>;
    expect(aps['mutable-content']).toBe(1);
    // Per-conversation grouping keyed on the channel.
    expect(aps['thread-id']).toBe('channel_chan-42');
    expect((aps.alert as { title: string; body: string }).body).toBe('Nouveau message');
    // The NSE reads the ciphertext from the payload (FCM does not merge the data map in).
    expect(req.payload.ciphertext).toBe('Q0lQSA==');
    expect(req.payload.nonce).toBe('Tk9OQ0U=');
  });

  it('builds a silent background push for a channel_read receipt', () => {
    const req = buildInternalApnsRequest('general', '', {
      type: 'channel_read',
      channelId: 'chan-42',
    });

    expect(req.pushType).toBe('background');
    expect(req.priority).toBe(5);
    const aps = req.payload.aps as Record<string, unknown>;
    expect(aps['content-available']).toBe(1);
    expect(aps.alert).toBeUndefined();
    expect(aps['mutable-content']).toBeUndefined();
  });

  it('honours an explicit silent flag', () => {
    const req = buildInternalApnsRequest('Canari', 'x', { type: 'social', silent: 'true' });
    expect(req.pushType).toBe('background');
    expect((req.payload.aps as Record<string, unknown>)['content-available']).toBe(1);
  });

  it('uses a per-kind thread and preserves the given body for social / form pushes', () => {
    const social = buildInternalApnsRequest('BDE', 'Nouveau post', { type: 'social' });
    expect((social.payload.aps as Record<string, unknown>)['thread-id']).toBe('canari_social');
    expect(((social.payload.aps as Record<string, unknown>).alert as { body: string }).body).toBe(
      'Nouveau post'
    );

    const form = buildInternalApnsRequest('Sondage', '', { type: 'form_reminder' });
    expect((form.payload.aps as Record<string, unknown>)['thread-id']).toBe('canari_forms');
  });
});
