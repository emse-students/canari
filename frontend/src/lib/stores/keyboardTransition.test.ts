import { describe, expect, it, vi } from 'vitest';
import {
  keyboardTransitionCount,
  keyboardTransitionMoving,
  noteKeyboardAtRest,
  noteKeyboardFrameAwaited,
  noteKeyboardFrameLanded,
  noteKeyboardTransition,
  noteKeyboardWillShow,
  onKeyboardTransitionEdge,
} from './keyboardTransition';
import { Log } from '$lib/utils/Log';

describe('the edges of a keyboard transition', () => {
  it('are heard once per start and once per rest, never for a change that belongs to one', () => {
    noteKeyboardAtRest('test start');
    const heard: string[] = [];
    const off = onKeyboardTransitionEdge((edge, n) => heard.push(`#${n} ${edge}`));
    const first = keyboardTransitionCount() + 1;
    noteKeyboardTransition('the shell: a keyboard will show');
    // The resize of the same rise belongs to the transition still moving.
    noteKeyboardTransition('keyboard open 279px -> open 279px');
    expect(keyboardTransitionMoving()).toBe(true);
    noteKeyboardAtRest('the shell: did show');
    noteKeyboardAtRest('a second word of rest');
    off();
    noteKeyboardTransition('after the unsubscribe');
    noteKeyboardAtRest('after the unsubscribe');
    expect(heard).toEqual([`#${first} starts`, `#${first} at rest`]);
  });

  it('a listener that throws is logged and does not stop the next one', () => {
    noteKeyboardAtRest('test start');
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
    const offA = onKeyboardTransitionEdge(() => {
      throw new Error('boom');
    });
    const heard = vi.fn();
    const offB = onKeyboardTransitionEdge(heard);
    noteKeyboardTransition('keyboard opened');
    noteKeyboardAtRest('at rest');
    offA();
    offB();
    expect(heard).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][1])).toContain('an edge listener threw');
    warn.mockRestore();
  });
});

/**
 * THE iOS REST IS TWO FACTS (iPhone 12, `1.8.0-alpha.6`, 5 returns of 11): the shell's word that the
 * keyboard is at rest, AND the WebView's frame for it landed (the hand-off spent). A keyboard coming
 * back with the app shows with no animation, so its rest could come before the frame - and the move the
 * resize brings was read as the reader's. The order of the two facts decides nothing.
 */
describe('a rest heard before the keyboard frame landed', () => {
  it('is held, and the transition keeps moving until the frame lands', () => {
    noteKeyboardAtRest('test start');
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
    const heard: string[] = [];
    const off = onKeyboardTransitionEdge((edge, n) => heard.push(`#${n} ${edge}`));
    noteKeyboardTransition('the shell: a keyboard will show');
    const n = keyboardTransitionCount();
    noteKeyboardFrameAwaited('a hand-off of 301px');
    noteKeyboardAtRest('the shell: did show');
    // The engine's move of the resize still to come belongs to this transition.
    expect(keyboardTransitionMoving()).toBe(true);
    expect(String(warn.mock.calls[0]?.[1])).toContain("before the keyboard's frame landed");
    noteKeyboardFrameLanded('keyboard target 301 spent');
    expect(keyboardTransitionMoving()).toBe(false);
    expect(heard).toEqual([`#${n} starts`, `#${n} at rest`]);
    off();
    warn.mockRestore();
  });

  it('a frame that lands first leaves the rest to the shell', () => {
    noteKeyboardAtRest('test start');
    noteKeyboardTransition('the shell: a keyboard will show');
    noteKeyboardFrameAwaited('a hand-off of 301px');
    noteKeyboardFrameLanded('keyboard target 301 spent');
    expect(keyboardTransitionMoving()).toBe(true);
    noteKeyboardAtRest('the shell: did show, after its frame');
    expect(keyboardTransitionMoving()).toBe(false);
  });

  it('a newer will-show drops a held rest: the frame landing does not end the transition', () => {
    noteKeyboardAtRest('test start');
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
    noteKeyboardWillShow('the shell: a keyboard will show');
    noteKeyboardFrameAwaited('a hand-off of 301px');
    noteKeyboardAtRest('the shell: did show, ahead of its frame');
    // A newer show joins the moving transition: its own did-show is the rest owed now, as in the shell.
    noteKeyboardWillShow('the shell: a keyboard will show again');
    noteKeyboardFrameLanded('keyboard target 301 spent');
    expect(keyboardTransitionMoving()).toBe(true);
    noteKeyboardAtRest('the shell: the newer show at rest');
    expect(keyboardTransitionMoving()).toBe(false);
    warn.mockRestore();
  });

  it('a note the viewport derives between the hold and the landing keeps the rest: it is the same change', () => {
    noteKeyboardAtRest('test start');
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
    noteKeyboardWillShow('the shell: a keyboard will show');
    noteKeyboardFrameAwaited('a hand-off of 301px');
    noteKeyboardAtRest('the shell: did show, ahead of its frame');
    noteKeyboardTransition('keyboard closed 0px -> open 301px');
    noteKeyboardFrameLanded('keyboard target 301 spent');
    expect(keyboardTransitionMoving()).toBe(false);
    warn.mockRestore();
  });

  it('a landing with no frame awaited, or no rest held, rests nothing', () => {
    noteKeyboardAtRest('test start');
    noteKeyboardTransition('keyboard opened');
    noteKeyboardFrameLanded('nothing was awaited');
    expect(keyboardTransitionMoving()).toBe(true);
    noteKeyboardAtRest('at rest');
    expect(keyboardTransitionMoving()).toBe(false);
  });
});
