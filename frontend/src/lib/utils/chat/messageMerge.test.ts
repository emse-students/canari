import {
  isEnvelopeContent,
  isFcmPreviewContent,
  shouldUpgradeMessage,
  mergeMessageUpgrade,
  bodyMeetsTombstone,
  absorbedTombstone,
} from './messageMerge';

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

describe('a body meeting a tombstone written before it arrived', () => {
  const early = {
    id: 'm1',
    senderId: 'Peer',
    content: 'deleted',
    timestamp: new Date(9_000),
    isOwn: false,
    isDeleted: true,
    deletedBeforeArrival: true,
  };

  it("is absorbed when it is the deleter's own, and anybody else's replaces the claim", () => {
    expect(bodyMeetsTombstone(early, 'peer')).toBe('absorb');
    expect(bodyMeetsTombstone(early, 'mallory')).toBe('replace');
  });

  it('leaves an ordinary row - an ordinary tombstone included - to the caller', () => {
    expect(bodyMeetsTombstone({ ...early, deletedBeforeArrival: undefined }, 'mallory')).toBe(
      'none'
    );
    expect(bodyMeetsTombstone({ ...early, isDeleted: undefined }, 'peer')).toBe('none');
  });

  it("keeps the tombstone and takes the body's place", () => {
    const absorbed = absorbedTombstone(early, {
      timestamp: new Date(2_000),
      serverTimestamp: 2_500,
    });
    expect(absorbed).toMatchObject({ content: 'deleted', isDeleted: true, serverTimestamp: 2_500 });
    expect(absorbed.timestamp.getTime()).toBe(2_000);
    expect(absorbed.deletedBeforeArrival).toBeUndefined();
  });

  it('never upgrades a deleted preview', () => {
    expect(
      shouldUpgradeMessage(
        { content: 'deleted', isFcmPreview: true, isDeleted: true },
        '{"kind":"text","text":"body"}'
      )
    ).toBe(false);
  });
});
