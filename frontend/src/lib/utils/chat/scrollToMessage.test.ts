import { describe, expect, it, vi } from 'vitest';
import { scrollMessageIntoList } from './scrollToMessage';

function rect(top: number, height: number): DOMRect {
  return { top, height, bottom: top + height } as DOMRect;
}

describe('scrollMessageIntoList', () => {
  it('scrolls only the list container, centring the target, and never calls scrollIntoView', () => {
    const container = document.createElement('div');
    const target = document.createElement('div');
    container.appendChild(target);
    document.body.appendChild(container);
    const scrollTo = vi.fn();
    const scrollIntoView = vi.fn();
    container.scrollTo = scrollTo;
    target.scrollIntoView = scrollIntoView;
    container.scrollTop = 100;
    Object.defineProperty(container, 'clientHeight', { value: 400 });
    container.getBoundingClientRect = () => rect(50, 400);
    target.getBoundingClientRect = () => rect(550, 40);

    scrollMessageIntoList(container, target);

    expect(scrollIntoView).not.toHaveBeenCalled();
    // content offset 100 + (550 - 50) = 600; centred: 600 - (400 - 40) / 2 = 420
    expect(scrollTo).toHaveBeenCalledWith({ top: 420, behavior: 'smooth' });
  });

  it('clamps at the top of the list', () => {
    const container = document.createElement('div');
    const target = document.createElement('div');
    container.scrollTo = vi.fn();
    Object.defineProperty(container, 'clientHeight', { value: 400 });
    container.getBoundingClientRect = () => rect(0, 400);
    target.getBoundingClientRect = () => rect(10, 40);
    scrollMessageIntoList(container, target, 'auto');
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });
});
