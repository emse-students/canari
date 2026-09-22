/// <reference types="jest" />

import {
  buildPushDataFields,
  buildApnsRequest,
  buildInternalApnsRequest,
  inlineProtoBudget,
  uninlinedProtoIsWorthReporting,
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

describe('a ciphertext that did not fit is only worth a line for the population it can accuse', () => {
  /**
   * The log line exists to catch the FIXED fields growing - `senderName` and `groupName` are
   * unbounded user text. That accusation is available for a message and unavailable for a welcome,
   * whose size is the group's ratchet tree. Measured on the local estate over 90 minutes on
   * 2026-09-08: 6 of 6 welcomes over budget, 0 of 9 messages. A predicate that is true of an entire
   * population tells its reader nothing about any member of it.
   */
  it('reports a message whose ciphertext did not fit', () => {
    expect(uninlinedProtoIsWorthReporting({ ...baseInput, isWelcome: false })).toBe(true);
  });

  it('says nothing about a welcome, whose size is the ratchet tree and never fits', () => {
    expect(uninlinedProtoIsWorthReporting({ ...baseInput, isWelcome: true })).toBe(false);
  });

  /**
   * THE SILENCE IS BOUNDED, AND THIS IS WHAT BOUNDS IT. Not inlining is not a failure - the client
   * fetches the ciphertext instead - and the failure that would matter, a payload FCM refuses, has
   * its own alarm at the point it happens. So the welcome case is the only thing that goes quiet,
   * and it goes quiet for every welcome rather than for some of them, which is the property that
   * makes it a structural fact rather than a swallowed branch.
   */
  it('is decided by the packet kind alone, not by how far over budget it went', () => {
    const huge = { ...baseInput, isWelcome: true, proto: 'A'.repeat(100_000) };
    const small = { ...baseInput, isWelcome: true, proto: 'A' };
    expect(uninlinedProtoIsWorthReporting(huge)).toBe(uninlinedProtoIsWorthReporting(small));
  });
});

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

/**
 * THE KIND OF CONVERSATION IS ITS OWN ANSWER, AND `groupName` WAS NEVER ABLE TO GIVE IT.
 *
 * Every reader used to test `groupName` for emptiness, which reads a DM, a group nobody named and
 * a group row the server could not fetch as the same thing. Production said the middle state is a
 * third of all groups. These pin the three, including the one that is an ABSENT key rather than a
 * false one: saying nothing and saying "DM" are different sentences, and a reader must be able to
 * tell them apart.
 */
describe('buildPushDataFields - the conversation kind, which used to be guessed from a name', () => {
  it('says so for a group', () => {
    expect(buildPushDataFields({ ...baseInput, isGroup: true }).isGroup).toBe('true');
  });

  it('says so for a DM, rather than leaving it to be inferred from an empty name', () => {
    expect(buildPushDataFields({ ...baseInput, groupName: '', isGroup: false }).isGroup).toBe(
      'false'
    );
  });

  it('SAYS SO FOR A GROUP NOBODY NAMED - the state that used to read as a DM', () => {
    const data = buildPushDataFields({ ...baseInput, groupName: '', isGroup: true });
    expect(data.groupName).toBe('');
    expect(data.isGroup).toBe('true');
  });

  it('OMITS THE KEY when the server could not read the row - absent is not false', () => {
    const data = buildPushDataFields({ ...baseInput, isGroup: undefined });
    expect('isGroup' in data).toBe(false);
  });

  it('costs the ciphertext exactly what it takes, because the budget is measured not guessed', () => {
    const withKind = inlineProtoBudget({ ...baseInput, isGroup: true });
    const without = inlineProtoBudget({ ...baseInput, isGroup: undefined });
    // 'isGroup' (7) + 'true' (4) in the data map; the APNs side carries it too, so the budget is
    // whichever of the two is larger - the point is that it MOVED, and by a bounded amount.
    expect(without - withKind).toBeGreaterThan(0);
    expect(without - withKind).toBeLessThan(40);
  });
});

/**
 * THE FRAME KIND, which `silent` cannot carry.
 *
 * `silent: 'true'` covers a read receipt, a self-read dismissal and a Graine seed alike, so the
 * Android service either drops all three - and a device shut when a session was minted never gets
 * its seed, leaving every message of that session showing the generic text - or decrypts all
 * three, paying an MLS load and the state lock for frames with nothing to say. The server already
 * knows which is which: a distribution group's log carries seeds and nothing else.
 */
describe('buildPushDataFields - a silent frame that has something to say', () => {
  it('names a key-distribution group, so a silent frame from it is worth opening', () => {
    const data = buildPushDataFields({ ...baseInput, silent: true, isKeyDistribution: true });
    expect(data.silent).toBe('true');
    expect(data.isKeyDistribution).toBe('true');
  });

  it('names an ordinary conversation, so its silent frames stay unopened', () => {
    expect(
      buildPushDataFields({ ...baseInput, silent: true, isKeyDistribution: false })
        .isKeyDistribution
    ).toBe('false');
  });

  it('OMITS THE KEY when the server could not read the row - absent is not false', () => {
    expect('isKeyDistribution' in buildPushDataFields(baseInput)).toBe(false);
  });
});

describe('buildPushDataFields - what a silent frame does NOT say to Google', () => {
  /**
   * `senderName` and `groupName` are the only unbounded USER TEXT in the payload - a real person's
   * display name and a conversation's title - and the payload is cleartext to FCM, and to APNs for
   * an iOS token. A silent frame draws nothing, so nothing reads them: the Android service returns
   * before any notification is built, and the iOS NSE is not even woken (it runs on
   * `mutable-content: 1` alerts, and every silent frame is `content-available: 1`). They were sent
   * on every frame regardless, and at least 28% of queued frames are commits alone.
   */
  it('carries neither display name on a silent frame', () => {
    const data = buildPushDataFields({ ...baseInput, silent: true });
    expect('senderName' in data).toBe(false);
    expect('groupName' in data).toBe(false);
  });

  it('still carries the three fields the silent path actually decides on', () => {
    const data = buildPushDataFields({ ...baseInput, silent: true });
    expect(data).toMatchObject({ groupId: 'group-1', senderId: 'user-sender', silent: 'true' });
  });

  it('carries both names on a visible frame, which is what draws the banner', () => {
    const data = buildPushDataFields(baseInput);
    expect(data).toMatchObject({ senderName: 'Alice', groupName: 'Asso BDE' });
  });

  it('spends no byte on a name a silent frame will not send, so the ciphertext gets them', () => {
    const shortNames = { ...baseInput, silent: true, senderName: 'A', groupName: 'B' };
    const longNames = {
      ...baseInput,
      silent: true,
      senderName: 'A'.repeat(300),
      groupName: 'B'.repeat(300),
    };
    expect(inlineProtoBudget(longNames)).toBe(inlineProtoBudget(shortNames));
    expect(inlineProtoBudget({ ...longNames, silent: false })).toBeLessThan(
      inlineProtoBudget(longNames)
    );
  });

  it('keeps them out of the APNs payload too, which is the half Apple reads', () => {
    const input = { ...baseInput, silent: true };
    const payload = buildApnsRequest(input, buildPushDataFields(input)).payload;
    expect(JSON.stringify(payload)).not.toContain('Alice');
    expect(JSON.stringify(payload)).not.toContain('Asso BDE');
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
