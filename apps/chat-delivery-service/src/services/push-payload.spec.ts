/// <reference types="jest" />

import {
  buildPushDataFields,
  buildApnsRequest,
  buildInternalApnsRequest,
  inlineProtoBudget,
  measureDataFields,
  measureApnsPayload,
  apnsFallbackBody,
  LONGEST_FALLBACK_LOCALE,
  FCM_DATA_LIMIT,
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

describe('the fallback body, the one sentence this server still composes', () => {
  const bodyOf = (locale?: string | null) =>
    (
      (
        buildApnsRequest(baseInput, buildPushDataFields(baseInput), locale).payload.aps as Record<
          string,
          unknown
        >
      ).alert as { body: string }
    ).body;

  it('writes the language the device told us', () => {
    expect(bodyOf('fr')).toBe('Nouveau message');
    expect(bodyOf('en')).toBe('New message');
  });

  it('reads a device that told us nothing as the base locale', () => {
    // Every row registered before the column existed, and every client that has not learned to
    // send it. Null is "not told", which is not the same fact as "told us something unknown" -
    // both land on the base locale, and neither may throw.
    expect(bodyOf(undefined)).toBe('Nouveau message');
    expect(bodyOf(null)).toBe('Nouveau message');
    expect(bodyOf('')).toBe('Nouveau message');
  });

  it('accepts a regional tag and a case this server did not write', () => {
    // The column is bounded, not validated: refusing a registration over a language tag would cost
    // the device every notification to spare it one word.
    expect(apnsFallbackBody('fr-FR')).toBe('Nouveau message');
    expect(apnsFallbackBody('EN')).toBe('New message');
    expect(apnsFallbackBody('de')).toBe('Nouveau message');
  });

  it('names the longest language rather than assuming which one it is', () => {
    // The budget below is sized on this. A literal here would be a copy of the table and would
    // drift the first time a language is added.
    expect(apnsFallbackBody(LONGEST_FALLBACK_LOCALE)).toBe('Nouveau message');
  });
});

describe('the budget is one number for devices that read different languages', () => {
  it('admits no ciphertext that a shorter-language payload would then exceed', () => {
    // THE INVARIANT THE PER-DEVICE BODY COULD HAVE BROKEN. One budget is computed, one ciphertext
    // is chosen from it, and the payload is then built per device: every language must therefore
    // produce a payload no larger than the one the budget measured.
    const budget = inlineProtoBudget(baseInput);
    const filled = { ...baseInput, proto: 'A'.repeat(budget) };
    const data = buildPushDataFields(filled);
    for (const locale of ['fr', 'en', undefined, 'de']) {
      expect(
        measureApnsPayload(buildApnsRequest(filled, data, locale).payload)
      ).toBeLessThanOrEqual(FCM_DATA_LIMIT);
    }
  });

  it('does not depend on which device is asking', () => {
    // `inlineProtoBudget` takes no locale on purpose: it is computed once per message, before any
    // token is looked at.
    expect(inlineProtoBudget(baseInput)).toBe(inlineProtoBudget({ ...baseInput }));
  });
});

describe('the inline-proto budget', () => {
  /** The shapes production actually carries, which the old 3 500 constant did not account for. */
  const realistic: PushMessageInput = {
    ...baseInput,
    groupId: '7da231f8-119c-4ce2-884f-55f5c94c903f',
    queuedMessageId: 'c1f0a2b3-4d5e-6f70-8192-a3b4c5d6e7f8',
    senderId: 'd82cd226e4a94b1f8c3d5e6f70819a2b3c4d5e6f708192a3b4c5d6e7f8091a2b',
    senderName: 'Jolan Boudin',
    groupName: 'GRP5-mt5rospko89-R',
    createdAt: '2026-08-29T13:11:07.482Z',
  };

  it('counts the keys, not only the values', () => {
    // 'silent' + 'false' is eleven bytes, and FCM charges for both halves.
    expect(measureDataFields({ silent: 'false' })).toBe(11);
  });

  it('is tighter than the data map alone, because the APNs framing costs more', () => {
    const empty = { ...realistic, proto: '' };
    const dataBytes = measureDataFields(buildPushDataFields(empty));
    const apnsBytes = measureApnsPayload(
      buildApnsRequest(empty, buildPushDataFields(empty)).payload
    );
    expect(apnsBytes).toBeGreaterThan(dataBytes);
    expect(inlineProtoBudget(realistic)).toBe(FCM_DATA_LIMIT - apnsBytes);
  });

  it('shrinks by exactly what a longer group name costs', () => {
    const short = inlineProtoBudget({ ...realistic, groupName: 'BDE' });
    const long = inlineProtoBudget({ ...realistic, groupName: 'BDE'.padEnd(203, 'x') });
    expect(short - long).toBe(200);
  });

  it('lands BOTH representations on the limit once the proto fills the budget', () => {
    const filled = { ...realistic, proto: 'A'.repeat(inlineProtoBudget(realistic)) };
    const fields = buildPushDataFields(filled);
    expect(measureDataFields(fields)).toBeLessThanOrEqual(FCM_DATA_LIMIT);
    expect(measureApnsPayload(buildApnsRequest(filled, fields).payload)).toBe(FCM_DATA_LIMIT);
  });

  it('refuses to inline anything when unbounded user text has already eaten the budget', () => {
    // senderName and groupName are display names: nothing upstream caps them.
    expect(
      inlineProtoBudget({
        ...realistic,
        senderName: 'e'.repeat(2_000),
        groupName: 'g'.repeat(2_000),
      })
    ).toBeLessThan(0);
  });

  it('THE REFUSAL: the two representations TOGETHER blow the limit that each alone respects', () => {
    // What the old code sent in a single message - `data` plus an `apns` payload spreading the
    // same fields - for a proto the old 3 500 constant passed. Ten refusals in one run, twice.
    const filled = { ...realistic, proto: 'A'.repeat(3_500) };
    const fields = buildPushDataFields(filled);
    const dataBytes = measureDataFields(fields);
    const apnsBytes = measureApnsPayload(buildApnsRequest(filled, fields).payload);
    expect(dataBytes).toBeLessThan(FCM_DATA_LIMIT);
    expect(dataBytes + apnsBytes).toBeGreaterThan(FCM_DATA_LIMIT);
  });
});
