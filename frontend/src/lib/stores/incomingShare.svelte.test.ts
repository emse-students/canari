const discardSharedFiles = vi.fn(async () => {});
vi.mock('$lib/mobile/sharedInbox', () => ({
  discardSharedFiles: (...args: unknown[]) => discardSharedFiles(...(args as [])),
}));

import { incomingShare } from './incomingShare.svelte';

/**
 * A share is a draft on its way to ONE conversation: offered, given a destination, taken once by
 * that destination. Each step below is a way it could be offered twice, to the wrong conversation,
 * or not at all.
 */
const file = (name: string) => ({
  path: `/cache/shared_inbox/x/0_${name}`,
  name,
  mime: 'image/png',
  size: 3,
});

describe('incomingShare', () => {
  beforeEach(() => {
    incomingShare.cancel();
    discardSharedFiles.mockClear();
  });

  it('deletes the copies of a share the member dismisses, and of one a newer share replaces', () => {
    incomingShare.offer({ text: '', files: [file('a.png')] });
    incomingShare.offer({ text: '', files: [file('b.png')] });
    expect(discardSharedFiles).toHaveBeenCalledWith(
      ['/cache/shared_inbox/x/0_a.png'],
      'replaced by a newer share'
    );
    incomingShare.cancel();
    expect(discardSharedFiles).toHaveBeenLastCalledWith(
      ['/cache/shared_inbox/x/0_b.png'],
      'cancelled by the member'
    );
  });

  it('deletes nothing of a share that was TAKEN - the chat page reads those copies', () => {
    incomingShare.offer({ text: '', files: [file('a.png')] });
    incomingShare.chooseTarget('group-1');
    incomingShare.takeFor('group-1');
    incomingShare.cancel();
    expect(discardSharedFiles).not.toHaveBeenCalled();
  });

  it('refuses an empty share', () => {
    expect(incomingShare.offer({ text: '   ', files: [] })).toBe(false);
    expect(incomingShare.pending).toBeNull();
  });

  it('holds an offered share without a destination until one is chosen', () => {
    expect(incomingShare.offer({ text: ' https://example.org ', files: [] })).toBe(true);
    expect(incomingShare.pending?.text).toBe('https://example.org');
    expect(incomingShare.target).toBeNull();
  });

  it('is taken only by the conversation chosen, and only once', () => {
    incomingShare.offer({ text: '', files: [file('a.png')] });
    incomingShare.chooseTarget('group-1');
    expect(incomingShare.takeFor('group-2')).toBeNull();
    const taken = incomingShare.takeFor('group-1');
    expect(taken?.files.map((f) => f.name)).toEqual(['a.png']);
    expect(incomingShare.takeFor('group-1')).toBeNull();
    expect(incomingShare.pending).toBeNull();
    expect(incomingShare.target).toBeNull();
  });

  it('is not taken before a destination is chosen', () => {
    incomingShare.offer({ text: 'hello', files: [] });
    expect(incomingShare.takeFor('group-1')).toBeNull();
    expect(incomingShare.pending).not.toBeNull();
  });

  it('replaces a share not yet taken, and the newer one asks for its own destination', () => {
    incomingShare.offer({ text: 'first', files: [] });
    incomingShare.chooseTarget('group-1');
    incomingShare.offer({ text: 'second', files: [] });
    expect(incomingShare.target).toBeNull();
    expect(incomingShare.takeFor('group-1')).toBeNull();
    expect(incomingShare.pending?.text).toBe('second');
  });

  it('drops the share when the member dismisses the picker', () => {
    incomingShare.offer({ text: 'hello', files: [] });
    incomingShare.cancel();
    expect(incomingShare.pending).toBeNull();
  });

  it('asks for its destination again when the landing on it ended undisplayed', () => {
    incomingShare.offer({ text: 'hello', files: [] });
    incomingShare.chooseTarget('group-1');
    incomingShare.releaseTarget();
    expect(incomingShare.target).toBeNull();
    expect(incomingShare.pending?.text).toBe('hello');
    expect(incomingShare.takeFor('group-1')).toBeNull();
  });

  it('ignores a destination when nothing is pending', () => {
    incomingShare.chooseTarget('group-1');
    expect(incomingShare.target).toBeNull();
  });
});

/**
 * THE FENCE A SIGN-OUT RAISES. Last in this file on purpose: the floor only rises, like the page's,
 * so every case above it offers at epoch 0 before any fence exists.
 */
describe('incomingShare.fence', () => {
  beforeEach(() => {
    incomingShare.cancel();
    discardSharedFiles.mockClear();
  });

  it('drops a held share from before the sign-out, and refuses one offered from before it', () => {
    incomingShare.offer({ text: 'from A', files: [file('a.png')] }, 1);
    incomingShare.fence(2, 'signed out');
    expect(incomingShare.pending).toBeNull();
    expect(discardSharedFiles).toHaveBeenCalledWith(
      ['/cache/shared_inbox/x/0_a.png'],
      'signed out'
    );

    expect(incomingShare.offer({ text: 'late A', files: [file('b.png')] }, 1)).toBe(false);
    expect(incomingShare.pending).toBeNull();
    expect(discardSharedFiles).toHaveBeenLastCalledWith(
      ['/cache/shared_inbox/x/0_b.png'],
      'offered after a sign-out'
    );

    expect(incomingShare.offer({ text: 'from B', files: [] }, 2)).toBe(true);
    // A second fence at the same epoch keeps what was offered in it.
    incomingShare.fence(2, 'signed out');
    expect(incomingShare.pending?.text).toBe('from B');
  });
});

/**
 * A share made inside Canari (a post's link, from its share sheet) arrives with its destination:
 * the "Envoyer a..." picker must never open for it, and no sign-out fence may refuse it.
 */
describe('incomingShare.offerTo', () => {
  beforeEach(() => {
    incomingShare.cancel();
    discardSharedFiles.mockClear();
  });

  it('offers the text with its destination in one step, and the destination takes it once', () => {
    expect(incomingShare.offerTo('https://canari.emse.fr/posts/p1', 'group-1')).toBe(true);
    expect(incomingShare.pending?.text).toBe('https://canari.emse.fr/posts/p1');
    expect(incomingShare.pending?.files).toEqual([]);
    expect(incomingShare.target).toBe('group-1');
    expect(incomingShare.takeFor('group-2')).toBeNull();
    expect(incomingShare.takeFor('group-1')?.text).toBe('https://canari.emse.fr/posts/p1');
    expect(incomingShare.takeFor('group-1')).toBeNull();
  });

  it('passes the fence of a sign-out this page already saw - it was made after it', () => {
    incomingShare.fence(7, 'signed out');
    expect(incomingShare.offerTo('https://canari.emse.fr/posts/p2', 'group-1')).toBe(true);
    expect(incomingShare.target).toBe('group-1');
  });

  it('is dropped by a sign-out like any held share', () => {
    incomingShare.offerTo('https://canari.emse.fr/posts/p3', 'group-1');
    incomingShare.drop('signed out');
    expect(incomingShare.pending).toBeNull();
    expect(incomingShare.target).toBeNull();
  });

  it('refuses an empty text and picks no destination', () => {
    expect(incomingShare.offerTo('  ', 'group-1')).toBe(false);
    expect(incomingShare.target).toBeNull();
  });
});
