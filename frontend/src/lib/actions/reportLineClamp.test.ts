import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reportLineClamp } from './reportLineClamp';

class FakeObserver {
  static last: FakeObserver | null = null;
  constructor(public cb: () => void) {
    FakeObserver.last = this;
  }
  observe() {}
  disconnect() {}
}

function box(scrollHeight: number, clientHeight: number): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  return el;
}

describe('reportLineClamp', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeObserver);
  });

  it('reports a block that is cut and one that fits', () => {
    const cut = vi.fn();
    reportLineClamp(box(120, 100), { active: true, text: 'long', onMeasure: cut });
    expect(cut).toHaveBeenLastCalledWith(true);

    const fits = vi.fn();
    reportLineClamp(box(100, 100), { active: true, text: 'short', onMeasure: fits });
    expect(fits).toHaveBeenLastCalledWith(false);
  });

  it('keeps its verdict while expanded and re-measures when the text changes', () => {
    const onMeasure = vi.fn();
    const action = reportLineClamp(box(120, 100), { active: true, text: 'a', onMeasure });
    onMeasure.mockClear();
    action.update({ active: false, text: 'a', onMeasure });
    expect(onMeasure).not.toHaveBeenCalled();
    action.update({ active: true, text: 'b', onMeasure });
    expect(onMeasure).toHaveBeenCalledWith(true);
  });
});
