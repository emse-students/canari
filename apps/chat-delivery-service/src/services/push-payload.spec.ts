/// <reference types="jest" />

import {
  buildPushDataFields,
  buildApnsRequest,
  buildInternalApnsRequest,
  inlineProtoBudget,
  decideProtoCarriage,
  measureDataFields,
  measureApnsPayload,
  apnsFallbackBody,
  LONGEST_FALLBACK_LOCALE,
  FCM_DATA_LIMIT,
  IOS_NOTIFICATION_SOUND,
  PushMessageInput,
  buildWakeApnsRequest,
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

describe('decideProtoCarriage: a typed outcome per packet kind', () => {
  it('inlines a message that fits', () => {
    const c = decideProtoCarriage({ ...baseInput }, 'AAEC');
    expect(c).toMatchObject({ kind: 'inlined', proto: 'AAEC', bytes: 4 });
  });

  it('carries a frame too long to fit even beside empty names by reference - a long text, expected', () => {
    // A signed frame is ~360 B (raw) longer than before (mls-core/tests/authored_frames.rs), so a
    // long text crossing the budget is the frame's own size, not the fixed fields growing.
    const c = decideProtoCarriage({ ...baseInput }, 'A'.repeat(100_000));
    expect(c).toMatchObject({ kind: 'long-frame', proto: '' });
  });

  it('accuses the fixed fields only when the frame would have fit beside empty names', () => {
    const longNames = {
      ...baseInput,
      senderName: 'S'.repeat(1500),
      groupName: 'G'.repeat(1500),
    };
    const bare = inlineProtoBudget({ ...baseInput, senderName: '', groupName: '' });
    const c = decideProtoCarriage(longNames, 'A'.repeat(bare));
    expect(c).toMatchObject({ kind: 'over-budget', proto: '' });
  });

  it('carries a first-contact welcome (4608 B) by reference, never inlined', () => {
    const c = decideProtoCarriage({ ...baseInput, isWelcome: true }, 'A'.repeat(4608));
    expect(c).toMatchObject({ kind: 'by-reference', proto: '', bytes: 4608 });
    expect(c.budget).toBeLessThan(4608);
  });

  it('carries even a small welcome by reference: the client always fetches the ratchet tree', () => {
    const c = decideProtoCarriage({ ...baseInput, isWelcome: true }, 'AAEC');
    expect(c.kind).toBe('by-reference');
  });

  it('keeps the data map under the FCM limit for a welcome', () => {
    const input = { ...baseInput, isWelcome: true };
    const c = decideProtoCarriage(input, 'A'.repeat(4608));
    expect(measureDataFields(buildPushDataFields({ ...input, proto: c.proto }))).toBeLessThan(
      FCM_DATA_LIMIT
    );
  });

  it('names a welcome as the reason it is carried by reference', () => {
    const c = decideProtoCarriage({ ...baseInput, isWelcome: true }, 'AAEC');
    expect(c).toMatchObject({ kind: 'by-reference', reason: 'welcome' });
  });

  // A Graine seed bundle is routinely kilobytes - a history answer is up to a 255 KiB page - so a
  // key-distribution frame over the inline budget is ordinary, not the fixed fields growing. It was
  // reported `over-budget` at warn for every multi-seed answer to an offline device.
  it('carries key material over the budget by reference, never as over-budget', () => {
    const input = { ...baseInput, silent: true, isKeyDistribution: true };
    const c = decideProtoCarriage(input, 'A'.repeat(100_000));
    expect(c).toMatchObject({ kind: 'by-reference', reason: 'key-material', proto: '' });
  });

  it('still inlines key material that fits, which the native mirror reads seeds from', () => {
    const input = { ...baseInput, silent: true, isKeyDistribution: true };
    expect(decideProtoCarriage(input, 'AAEC')).toMatchObject({ kind: 'inlined', proto: 'AAEC' });
  });

  it('keeps accusing an over-budget frame when the server could not say it was key material', () => {
    // A frame that would have fit beside empty names, so only the key-material excuse could
    // spare it the accusation - and an unclassified frame is not given that excuse.
    const input = {
      ...baseInput,
      isKeyDistribution: undefined,
      senderName: 'S'.repeat(1500),
      groupName: 'G'.repeat(1500),
    };
    const bare = inlineProtoBudget({ ...input, senderName: '', groupName: '' });
    expect(decideProtoCarriage(input, 'A'.repeat(bare)).kind).toBe('over-budget');
  });

  it('reports nothing to carry as empty', () => {
    expect(decideProtoCarriage({ ...baseInput }, '').kind).toBe('empty');
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

describe('a conversation set to mentions - the device decides, the server only says so', () => {
  it('carries notifLevel=mentions on a visible frame', () => {
    expect(buildPushDataFields({ ...baseInput, mentionsOnly: true }).notifLevel).toBe('mentions');
  });

  it('carries no notifLevel at the ordinary level, so the frame costs no byte more', () => {
    expect(buildPushDataFields({ ...baseInput }).notifLevel).toBeUndefined();
    expect(buildPushDataFields({ ...baseInput, mentionsOnly: false }).notifLevel).toBeUndefined();
  });

  it('never carries it on a silent frame, which draws nothing anyway', () => {
    const data = buildPushDataFields({ ...baseInput, silent: true, mentionsOnly: true });
    expect(data.notifLevel).toBeUndefined();
  });

  it('leaves APNs quiet - passive, no sound - so only the extension can make it ring', () => {
    const input = { ...baseInput, mentionsOnly: true };
    const aps = buildApnsRequest(input, buildPushDataFields(input)).payload.aps;
    expect(aps['interruption-level']).toBe('passive');
    expect(aps.sound).toBeUndefined();
    expect(aps['mutable-content']).toBe(1);
  });

  it('rings an ordinary visible frame with the palette-A message trill', () => {
    const aps = buildApnsRequest(baseInput, buildPushDataFields(baseInput)).payload.aps;
    expect(aps.sound).toBe(IOS_NOTIFICATION_SOUND.message);
    expect(aps['interruption-level']).toBeUndefined();
  });

  it('sizes the ciphertext budget with the extra field counted', () => {
    expect(inlineProtoBudget({ ...baseInput, mentionsOnly: true })).toBeLessThan(
      inlineProtoBudget(baseInput)
    );
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
  it('keeps deepLink a top-level key of the payload, where the iOS tap handler reads it', () => {
    // The tap handler opens `userInfo["deepLink"]` and derives nothing from postId or formId, so a
    // link the server wrote must survive into the APNs payload next to `aps`, never nested.
    const deepLink = 'fr.emse.canari://post/post-7';
    const req = buildInternalApnsRequest('Asso', 'A new post', {
      type: 'association_post',
      postId: 'post-7',
      deepLink,
    });
    expect(req.payload.deepLink).toBe(deepLink);
    expect((req.payload.aps as Record<string, unknown>).deepLink).toBeUndefined();
  });

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

  it('stacks the reactions to one post under that post, and other posts apart', () => {
    const react = (postId: string) =>
      buildInternalApnsRequest('Nouvelle réaction', '', {
        type: 'social',
        contentKey: 'social_reaction',
        postId,
      });
    const thread = (r: ReturnType<typeof react>) =>
      (r.payload.aps as Record<string, unknown>)['thread-id'];
    expect(thread(react('p1'))).toBe('post_reaction_p1');
    expect(thread(react('p2'))).toBe('post_reaction_p2');
    // A comment on the same post is a different notification and keeps the coarse thread.
    const comment = buildInternalApnsRequest('x', 'y', {
      type: 'social',
      contentKey: 'social_comment',
      postId: 'p1',
    });
    expect(thread(comment)).toBe('canari_social');
  });

  it('names the palette-A trill Android files the same push under, and the default elsewhere', () => {
    const sound = (data: Record<string, string>) =>
      (buildInternalApnsRequest('t', 'b', data).payload.aps as Record<string, unknown>).sound;
    // A salon message: mention when the server computed it names this recipient (canari_mentions_v2).
    expect(sound({ type: 'channel', channelId: 'c1', mentioned: 'true' })).toBe(
      IOS_NOTIFICATION_SOUND.mention
    );
    expect(sound({ type: 'channel', channelId: 'c1', mentioned: 'false' })).toBe(
      IOS_NOTIFICATION_SOUND.message
    );
    // A reaction to one of my messages (canari_reactions_v2).
    expect(sound({ type: 'social', reaction: 'true', groupId: 'g1' })).toBe(
      IOS_NOTIFICATION_SOUND.reaction
    );
    // Posts, comments and forms ride canari_social / canari_forms, which play the default.
    expect(sound({ type: 'social', contentKey: 'social_comment', postId: 'p1' })).toBe('default');
    expect(sound({ type: 'form_reminder', formId: 'f1' })).toBe('default');
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
    groupId: '00000000-0000-4000-8000-000000000001',
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

describe('buildWakeApnsRequest', () => {
  it('keeps a mentions frame passive and soundless, and names nothing', () => {
    const request = buildWakeApnsRequest('q-1', false, true, 'en');
    expect(request.payload).toEqual({
      aps: {
        'mutable-content': 1,
        alert: { title: 'Canari', body: 'New message' },
        'interruption-level': 'passive',
      },
      type: 'wake',
      queuedMessageId: 'q-1',
      silent: 'false',
    });
    expect(request.pushType).toBe('alert');
  });

  it('plays the message trill on an ordinary frame', () => {
    const aps = buildWakeApnsRequest('q-1', false, false, 'fr').payload.aps;
    expect(aps.sound).toBe(IOS_NOTIFICATION_SOUND.message);
    expect(aps['interruption-level']).toBeUndefined();
  });
});
