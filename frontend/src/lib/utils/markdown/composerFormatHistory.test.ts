import { describe, it, expect } from 'vitest';
import { ComposerFormatHistory, historyKeyAction } from './composerFormatHistory';

const snap = (text: string, start = 0, end = start) => ({ text, start, end });

describe('historyKeyAction', () => {
  const key = (k: string, o: Partial<KeyboardEvent> = {}) =>
    historyKeyAction({
      key: k,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      ...o,
    });
  it('reads undo and redo on Ctrl and Cmd, and nothing else', () => {
    expect(key('z', { ctrlKey: true })).toBe('undo');
    expect(key('Z', { metaKey: true })).toBe('undo');
    expect(key('z', { ctrlKey: true, shiftKey: true })).toBe('redo');
    expect(key('y', { ctrlKey: true })).toBe('redo');
    expect(key('y', { metaKey: true })).toBeNull();
    expect(key('z')).toBeNull();
    expect(key('z', { ctrlKey: true, altKey: true })).toBeNull();
    expect(key('b', { ctrlKey: true })).toBeNull();
  });
});

describe('ComposerFormatHistory', () => {
  it('undoes then redoes a toolbar action while the text is the one it left', () => {
    const h = new ComposerFormatHistory();
    h.record(snap('word', 0, 4), snap('**word**', 2, 6));
    expect(h.undo('**word**')).toEqual(snap('word', 0, 4));
    expect(h.redo('word')).toEqual(snap('**word**', 2, 6));
    expect(h.undo('**word**')).toEqual(snap('word', 0, 4));
  });

  it('hands the key to the browser once the member typed after the action', () => {
    const h = new ComposerFormatHistory();
    h.record(snap('word', 0, 4), snap('**word**', 2, 6));
    expect(h.undo('**word** x')).toBeNull();
    // The entry is still there for when the text is back to what the action left.
    expect(h.undo('**word**')).toEqual(snap('word', 0, 4));
  });

  it('typing after an undo drops the redo side', () => {
    const h = new ComposerFormatHistory();
    h.record(snap('word', 0, 4), snap('**word**', 2, 6));
    h.undo('**word**');
    expect(h.redo('word typed')).toBeNull();
    expect(h.redo('word')).toBeNull();
  });

  it('a new action drops the redo side and actions undo in order', () => {
    const h = new ComposerFormatHistory();
    h.record(snap('a'), snap('**a**'));
    h.record(snap('**a**'), snap('***a***'));
    expect(h.undo('***a***')).toEqual(snap('**a**'));
    h.record(snap('**a**'), snap('# **a**'));
    expect(h.redo('**a**')).toBeNull();
    expect(h.undo('# **a**')).toEqual(snap('**a**'));
    expect(h.undo('**a**')).toEqual(snap('a'));
    expect(h.undo('a')).toBeNull();
  });
});
