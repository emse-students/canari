/**
 * TYPING FOLDS THE EDGE CONTROLS - EVERY TIME, NOT ONLY ON THE FIRST CHARACTER.
 *
 * The composer hides paperclip / poll / GIF / microphone once a message is being written, and puts
 * a chevron in their place so they are one tap away rather than gone. The first version held that
 * chevron's request for the whole message: press it and the four buttons stayed out for every
 * character typed afterwards.
 *
 * On a phone that is the crowding the fold exists to remove, restored permanently by one tap - the
 * group is 4 x 52px of a ~358px row. The user asked for the opposite (2026-09-09: *"Taper sur le
 * clavier doit TOUJOURS replier joindre, GIF, micro, pas juste au premier caractere"*), so the
 * request now lasts until the next keystroke.
 *
 * THE KEYSTROKE IS DELIVERED THROUGH THE REAL EDITOR, not by calling the handler. The composer's
 * text arrives from a contenteditable through `MentionComposerInput`, which emits only when the
 * serialized text actually moved and never mid-IME-composition; a test that called
 * `handleMessageChange` directly would pass against a build where nothing is wired to it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatComposer from './ChatComposer.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

/** The chevron shares the icon-button class, so "the folded group" is the buttons that are not it. */
function groupButtons(): Element[] {
  return [...document.querySelectorAll('.chat-composer-icon-button:not(.chat-composer-chevron)')];
}
function chevron(): HTMLElement | null {
  return document.querySelector('.chat-composer-chevron');
}
function editor(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="textbox"]');
  if (!el) throw new Error('composer editor not found');
  return el;
}

/** One keystroke, as the browser delivers it: the DOM changes, then `input` fires. */
function type(text: string): void {
  const el = editor();
  el.textContent = text;
  el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  flushSync();
}

describe('ChatComposer - the edge controls fold on every keystroke', () => {
  interface Harness {
    messageText: string;
    onMessageChange: (v: string) => void;
    onSend: () => void;
    onCreatePoll: () => void;
  }

  /**
   * Controlled input: the parent owns `messageText`, so the harness feeds it back. Declared inside
   * this function because `$state` may only initialise a declaration - assigning it to an
   * already-declared `let` in `beforeEach` is a compile error, not a runtime one.
   */
  function mountComposer(): Harness {
    const props: Harness = $state({
      messageText: '',
      onMessageChange: (v: string) => {
        props.messageText = v;
      },
      onSend: () => {},
      // Passed so the folded group has more than one member, which is what makes it worth folding.
      onCreatePoll: () => {},
    });
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(ChatComposer, { target, props });
    mounted.push(() => void unmount(app));
    flushSync();
    return props;
  }

  let props: Harness;

  beforeEach(() => {
    props = mountComposer();
  });

  it('shows the group while the message is empty, and no chevron', () => {
    expect(groupButtons().length).toBeGreaterThan(0);
    expect(chevron()).toBeNull();
  });

  it('folds the group on the first character', () => {
    type('h');

    expect(props.messageText).toBe('h');
    expect(groupButtons()).toHaveLength(0);
    expect(chevron()).not.toBeNull();
  });

  it('brings the group back when the chevron is pressed', () => {
    type('h');
    chevron()!.click();
    flushSync();

    expect(groupButtons().length).toBeGreaterThan(0);
    expect(chevron()).toBeNull();
  });

  it('FOLDS IT AGAIN ON THE VERY NEXT CHARACTER - the regression this file exists for', () => {
    type('h');
    chevron()!.click();
    flushSync();
    expect(groupButtons().length).toBeGreaterThan(0);

    type('he');

    expect(props.messageText).toBe('he');
    expect(groupButtons()).toHaveLength(0);
    expect(chevron()).not.toBeNull();
  });

  it('keeps folding on every character after that, not just the one following the tap', () => {
    type('h');
    chevron()!.click();
    flushSync();

    for (const text of ['he', 'hel', 'hell', 'hello']) {
      type(text);
      expect(chevron(), `folded after "${text}"`).not.toBeNull();
      expect(groupButtons(), `folded after "${text}"`).toHaveLength(0);
    }
  });

  it('gives the group back when the message is emptied, with no tap needed', () => {
    type('h');
    type('');

    expect(props.messageText).toBe('');
    expect(groupButtons().length).toBeGreaterThan(0);
    expect(chevron()).toBeNull();
  });
});
