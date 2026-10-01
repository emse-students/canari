import { hasActiveTextSelection, onTextSelectionActive } from './textSelection';

/** The three fields the predicate reads; happy-dom's own Selection cannot be driven from a test. */
function fakeSelection(text: string, collapsed = text.length === 0, rangeCount = 1): Selection {
  return {
    rangeCount,
    isCollapsed: collapsed,
    toString: () => text,
  } as unknown as Selection;
}

describe('hasActiveTextSelection', () => {
  it('is false with no selection object', () => {
    expect(hasActiveTextSelection(null)).toBe(false);
  });

  it('is false for a caret, which is a collapsed range', () => {
    expect(hasActiveTextSelection(fakeSelection('', true))).toBe(false);
  });

  it('is false with no range at all', () => {
    expect(hasActiveTextSelection(fakeSelection('', true, 0))).toBe(false);
  });

  it('is true while text is selected', () => {
    expect(hasActiveTextSelection(fakeSelection('copy me', false))).toBe(true);
  });

  it('reads the live window selection by default', () => {
    const spy = vi.spyOn(window, 'getSelection').mockReturnValue(fakeSelection('abc', false));
    expect(hasActiveTextSelection()).toBe(true);
    spy.mockReturnValue(fakeSelection(''));
    expect(hasActiveTextSelection()).toBe(false);
    spy.mockRestore();
  });
});

describe('onTextSelectionActive', () => {
  it('fires on selectionchange only while a range is selected, and stops after unsubscribe', () => {
    const onSelect = vi.fn();
    const stop = onTextSelectionActive(onSelect);
    const spy = vi.spyOn(window, 'getSelection').mockReturnValue(fakeSelection(''));

    document.dispatchEvent(new Event('selectionchange'));
    expect(onSelect).not.toHaveBeenCalled();

    spy.mockReturnValue(fakeSelection('abc', false));
    document.dispatchEvent(new Event('selectionchange'));
    expect(onSelect).toHaveBeenCalledTimes(1);

    stop();
    document.dispatchEvent(new Event('selectionchange'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
