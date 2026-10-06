import { describe, expect, it, vi } from 'vitest';
import { onTouchGestureEnd } from './touchGestureEnd';

describe('onTouchGestureEnd', () => {
  it('still hears the end when the touched element was removed from the DOM mid-gesture', () => {
    const shell = document.createElement('div');
    const card = document.createElement('div');
    shell.appendChild(card);
    document.body.appendChild(shell);
    const viaShell = vi.fn();
    shell.addEventListener('touchend', viaShell);
    const viaTarget = vi.fn();
    onTouchGestureEnd(card, viaTarget);

    card.remove();
    card.dispatchEvent(new Event('touchend', { bubbles: true }));

    expect(viaShell).not.toHaveBeenCalled();
    expect(viaTarget).toHaveBeenCalledTimes(1);
  });

  it('treats touchcancel as an end and fires once', () => {
    const el = document.createElement('div');
    const handler = vi.fn();
    onTouchGestureEnd(el, handler);
    el.dispatchEvent(new Event('touchcancel'));
    el.dispatchEvent(new Event('touchend'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('the disposer detaches both listeners', () => {
    const el = document.createElement('div');
    const handler = vi.fn();
    onTouchGestureEnd(el, handler)();
    el.dispatchEvent(new Event('touchend'));
    expect(handler).not.toHaveBeenCalled();
  });
});
