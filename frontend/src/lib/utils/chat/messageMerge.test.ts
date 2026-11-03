import {
  isEnvelopeContent,
  isFcmPreviewContent,
  shouldUpgradeMessage,
  mergeMessageUpgrade,
  previewUpgradeOnto,
  isPushPreview,
  mergeMessagePage,
} from './messageMerge';
import { editSupersedes } from './editPrecedence';
import type { StoredMessage } from '$lib/db/types';

describe('messageMerge', () => {
  it('detects envelope JSON vs plain preview', () => {
    expect(isEnvelopeContent('{"kind":"text","text":"hi"}')).toBe(true);
    expect(isFcmPreviewContent('Hello from notification')).toBe(true);
  });

  it('upgrades FCM preview when MLS envelope arrives', () => {
    const existing = {
      content: 'preview text',
      isFcmPreview: true,
    };
    const incoming =
      '{"kind":"text","text":"full message","replyTo":{"id":"1","senderId":"a","content":"q"}}';
    expect(shouldUpgradeMessage(existing, incoming)).toBe(true);

    const merged = mergeMessageUpgrade(
      {
        id: 'm1',
        senderId: 'user-a',
        content: 'preview text',
        timestamp: new Date(1000),
        isOwn: false,
        isFcmPreview: true,
      },
      {
        content: incoming,
        senderId: 'user-a',
        replyTo: { id: '1', senderId: 'a', content: 'q' },
      }
    );
    expect(merged.isFcmPreview).toBe(false);
    expect(merged.content).toBe(incoming);
  });

  it('does not upgrade full envelope with duplicate delivery', () => {
    const existing = {
      content: '{"kind":"text","text":"already full"}',
      isFcmPreview: false,
    };
    expect(shouldUpgradeMessage(existing, '{"kind":"text","text":"other"}')).toBe(false);
  });
});

describe('a deleted preview', () => {
  it('is never upgraded - the deletion is final', () => {
    expect(
      shouldUpgradeMessage(
        { content: 'deleted', isFcmPreview: true, isDeleted: true },
        '{"kind":"text","text":"body"}'
      )
    ).toBe(false);
  });
});

describe('previewUpgradeOnto - a preview upgrade folded onto the row as it stands', () => {
  const BODY = '{"kind":"text","text":"the body"}';
  const preview = (over: Partial<StoredMessage> = {}): StoredMessage => ({
    id: 'm1',
    conversationId: 'c',
    senderId: 'alice',
    content: 'caption',
    timestamp: 1,
    isFcmPreview: true,
    ...over,
  });
  const upgrade: StoredMessage = {
    id: 'm1',
    conversationId: 'c',
    senderId: 'alice',
    content: BODY,
    timestamp: 1,
    serverTimestamp: 7,
    isFcmPreview: false,
  };

  it('keeps a reaction the stored preview took after memory was read (the bulk row carries none)', () => {
    const bob = { userId: 'bob', emoji: '👍', at: 5 };
    const next = previewUpgradeOnto(preview({ reactions: [bob] }), upgrade);
    expect(next).toMatchObject({ content: BODY, isFcmPreview: false, serverTimestamp: 7 });
    expect(next?.reactions).toEqual([bob]);
  });

  it('unions both sides reactions, and keeps an edit the upgrade does not carry', () => {
    const next = previewUpgradeOnto(
      preview({ reactions: [{ userId: 'bob', emoji: '👍', at: 5 }] }),
      { ...upgrade, reactions: [{ userId: 'carol', emoji: '🎉', at: 6 }], isDeleted: false }
    );
    expect(next?.reactions?.map((r) => r.userId).sort()).toEqual(['bob', 'carol']);
    expect(next?.isDeleted).toBeUndefined();
  });

  it('leaves a row that is no longer a preview - deleted, or upgraded by another writer', () => {
    expect(previewUpgradeOnto(preview({ isDeleted: true }), upgrade)).toBeNull();
    expect(previewUpgradeOnto(preview({ content: BODY, isFcmPreview: false }), upgrade)).toBeNull();
  });
});

describe('an edit the preview took is carried onto the body that upgrades it', () => {
  const BODY =
    '{"kind":"text","text":"the original","replyTo":{"id":"q","senderId":"a","content":"quoted"}}';
  const EDITED_PREVIEW = '{"kind":"text","text":"the edited text"}';

  it('previewUpgradeOnto: a bundle edit on the stored preview survives the body arriving', () => {
    const next = previewUpgradeOnto(
      {
        id: 'm1',
        conversationId: 'c',
        senderId: 'alice',
        content: EDITED_PREVIEW,
        timestamp: 1,
        isFcmPreview: true,
        isEdited: true,
        editedAt: 5_000,
      },
      { id: 'm1', conversationId: 'c', senderId: 'alice', content: BODY, timestamp: 1 }
    );
    expect(next).toMatchObject({ isEdited: true, editedAt: 5_000, isFcmPreview: false });
    expect(JSON.parse(next!.content)).toMatchObject({
      text: 'the edited text',
      replyTo: { id: 'q' },
    });
  });

  it('mergeMessageUpgrade: the same on screen', () => {
    const merged = mergeMessageUpgrade(
      {
        id: 'm1',
        senderId: 'alice',
        content: EDITED_PREVIEW,
        timestamp: new Date(1),
        isOwn: false,
        isFcmPreview: true,
        isEdited: true,
        editedAt: new Date(5_000),
      },
      { content: BODY, senderId: 'alice' }
    );
    expect(JSON.parse(merged.content)).toMatchObject({ text: 'the edited text' });
    expect(merged.isEdited).toBe(true);
  });

  it('an unedited preview takes the body as it is', () => {
    const merged = mergeMessageUpgrade(
      { id: 'm1', senderId: 'a', content: 'caption', timestamp: new Date(1), isOwn: false },
      { content: BODY, senderId: 'a' }
    );
    expect(merged.content).toBe(BODY);
  });
});

describe('isPushPreview', () => {
  it('reads an unflagged non-envelope row an older build stored as a preview, never a tombstone', () => {
    expect(isPushPreview({ content: 'caption' })).toBe(true);
    expect(isPushPreview({ content: '{"kind":"text","text":"x"}', isFcmPreview: true })).toBe(true);
    expect(isPushPreview({ content: '{"kind":"text","text":"x"}' })).toBe(false);
    expect(isPushPreview({ content: 'deleted', isDeleted: true })).toBe(false);
  });
});

describe('the edit an upgrade keeps is decided by editSupersedes, and its proof goes with its text', () => {
  const PROOF_ROW = { body: 'cm93', proof: 'cm93LXByb29m', group: 'c' };
  const PROOF_BODY = { body: 'Ym9keQ==', proof: 'Ym9keS1wcm9vZg==', group: 'c' };
  const editedPreview = (over: Partial<StoredMessage> = {}): StoredMessage => ({
    id: 'm1',
    conversationId: 'c',
    senderId: 'alice',
    content: '{"kind":"text","text":"row edit"}',
    timestamp: 1,
    isFcmPreview: true,
    isEdited: true,
    editedAt: 9_000,
    editProof: PROOF_ROW,
    ...over,
  });
  const editedBody = (over: Partial<StoredMessage> = {}): StoredMessage => ({
    id: 'm1',
    conversationId: 'c',
    senderId: 'alice',
    content: '{"kind":"text","text":"body edit"}',
    timestamp: 1,
    isEdited: true,
    editedAt: 3_000,
    editProof: PROOF_BODY,
    ...over,
  });
  const text = (row: StoredMessage | null) => JSON.parse(row!.content).text;

  it("a newer row edit beats the upgrade's older one - text, time and proof all the row's", () => {
    const next = previewUpgradeOnto(editedPreview(), editedBody());
    expect(text(next)).toBe('row edit');
    expect(next).toMatchObject({ isEdited: true, editedAt: 9_000, editProof: PROOF_ROW });
  });

  it("an upgrade's newer edit beats the row's - text, time and proof all the upgrade's", () => {
    const next = previewUpgradeOnto(editedPreview({ editedAt: 1_000 }), editedBody());
    expect(text(next)).toBe('body edit');
    expect(next).toMatchObject({ editedAt: 3_000, editProof: PROOF_BODY });
  });

  it('a tie goes to the greater text, by the one rule', () => {
    // "row edit" > "body edit": the row's wins at equal times.
    const tie = previewUpgradeOnto(editedPreview({ editedAt: 3_000 }), editedBody());
    expect(text(tie)).toBe('row edit');
    expect(tie).toMatchObject({ editProof: PROOF_ROW });
    // And the other way round when the body's text is the greater.
    const other = previewUpgradeOnto(
      editedPreview({ editedAt: 3_000 }),
      editedBody({ content: '{"kind":"text","text":"zz body edit"}' })
    );
    expect(text(other)).toBe('zz body edit');
    expect(other).toMatchObject({ editProof: PROOF_BODY });
  });

  it("never carries the preview's edit onto another sender's body", () => {
    const next = previewUpgradeOnto(editedPreview({ senderId: 'mallory' }), {
      id: 'm1',
      conversationId: 'c',
      senderId: 'alice',
      content: '{"kind":"text","text":"as sent"}',
      timestamp: 1,
    });
    expect(text(next)).toBe('as sent');
    expect(next?.isEdited).toBe(false);
    expect(next?.editProof ?? null).toBeNull();
    const shown = mergeMessageUpgrade(
      {
        id: 'm1',
        senderId: 'mallory',
        content: '{"kind":"text","text":"row edit"}',
        timestamp: new Date(1),
        isOwn: false,
        isFcmPreview: true,
        isEdited: true,
        editedAt: new Date(9_000),
      },
      { content: '{"kind":"text","text":"as sent"}', senderId: 'alice' }
    );
    expect(JSON.parse(shown.content).text).toBe('as sent');
    expect(shown.isEdited).toBeFalsy();
    expect(shown.editedAt).toBeUndefined();
  });
});

describe('reconcile - a stored body whose own edit wins keeps its edit mark in memory', () => {
  it('shows the body edited, with its editedAt, and refuses a later-arriving older edit', () => {
    const preview = {
      id: 'm1',
      senderId: 'alice',
      content: '{"kind":"text","text":"preview edit"}',
      timestamp: new Date(1_000),
      isOwn: false,
      isFcmPreview: true,
      isEdited: true,
      editedAt: new Date(2_000),
    };
    const storedBody = {
      id: 'm1',
      senderId: 'alice',
      content: '{"kind":"text","text":"body edit"}',
      timestamp: new Date(1_000),
      isOwn: false,
      isEdited: true,
      editedAt: new Date(9_000),
    };

    const [row] = mergeMessagePage([preview], [storedBody]);

    expect(JSON.parse(row.content).text).toBe('body edit');
    expect(row.isEdited).toBe(true);
    expect(row.editedAt?.getTime()).toBe(9_000);
    expect(row.isFcmPreview).toBe(false);
    // An older edit arriving later is refused in memory, as the store refuses it.
    expect(editSupersedes({ editedAt: 5_000, content: 'older' }, row)).toBe(false);
  });
});
