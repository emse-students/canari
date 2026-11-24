import { describe, expect, it, vi } from 'vitest';
import {
  keyboardTransitionCount,
  keyboardTransitionMoving,
  noteKeyboardAtRest,
  noteKeyboardTransition,
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
