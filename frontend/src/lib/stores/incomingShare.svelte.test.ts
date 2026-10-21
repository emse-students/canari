import { incomingShare } from './incomingShare.svelte';

/**
 * A share is a draft on its way to ONE conversation: offered, given a destination, taken once by
 * that destination. Each step below is a way it could be offered twice, to the wrong conversation,
 * or not at all.
 */
const file = (name: string) => new File(['x'], name, { type: 'image/png' });

describe('incomingShare', () => {
  beforeEach(() => incomingShare.cancel());

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

  it('ignores a destination when nothing is pending', () => {
    incomingShare.chooseTarget('group-1');
    expect(incomingShare.target).toBeNull();
  });
});
