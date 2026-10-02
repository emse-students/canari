import { describe, it, expect, vi } from 'vitest';
import { createEditSession } from './editSession.svelte';

/** A composer that holds one string, as `MainChatPage`'s `messageText` does. */
function harness(initial = '') {
  const box = { text: initial };
  const save = vi.fn();
  const session = createEditSession({
    getText: () => box.text,
    setText: (t) => (box.text = t),
    save,
  });
  return { box, save, session };
}

describe('createEditSession', () => {
  it('loads the message into the composer and names it', () => {
    const { box, session } = harness('');
    expect(session.original).toBeNull();
    session.begin('m1', 'bonjour');
    expect(box.text).toBe('bonjour');
    expect(session.original).toBe('bonjour');
  });

  it('gives the draft back on cancel - a typo fix must not eat the sentence being typed', () => {
    const { box, session, save } = harness('une phrase a moitie');
    session.begin('m1', 'bonjour');
    box.text = 'bonsoir';
    session.cancel();
    expect(box.text).toBe('une phrase a moitie');
    expect(session.original).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('saves the edited text and gives the draft back on confirm', () => {
    const { box, session, save } = harness('brouillon');
    session.begin('m1', 'bonjour');
    box.text = '  bonsoir  ';
    session.confirm();
    expect(save).toHaveBeenCalledExactlyOnceWith('m1', 'bonsoir');
    expect(box.text).toBe('brouillon');
    expect(session.original).toBeNull();
  });

  it('saves nothing for an unchanged or an empty text, and still gives the draft back', () => {
    const unchanged = harness('brouillon');
    unchanged.session.begin('m1', 'bonjour');
    unchanged.box.text = 'bonjour ';
    unchanged.session.confirm();
    expect(unchanged.save).not.toHaveBeenCalled();
    expect(unchanged.box.text).toBe('brouillon');

    const empty = harness('brouillon');
    empty.session.begin('m1', 'bonjour');
    empty.box.text = '   ';
    empty.session.confirm();
    expect(empty.save).not.toHaveBeenCalled();
    expect(empty.box.text).toBe('brouillon');
  });

  it('keeps the FIRST draft when one edit is followed straight by another', () => {
    const { box, session } = harness('mon brouillon');
    session.begin('m1', 'premier');
    session.begin('m2', 'second');
    expect(box.text).toBe('second');
    expect(session.original).toBe('second');
    session.cancel();
    expect(box.text).toBe('mon brouillon');
  });

  it('does nothing when nothing is being edited', () => {
    const { box, session, save } = harness('texte');
    session.cancel();
    session.confirm();
    expect(box.text).toBe('texte');
    expect(save).not.toHaveBeenCalled();
  });

  it('reset leaves the text alone: the conversation changed and the text went with it', () => {
    const { box, session } = harness('ancien');
    session.begin('m1', 'bonjour');
    box.text = '';
    session.reset();
    expect(session.original).toBeNull();
    expect(box.text).toBe('');
  });
});
