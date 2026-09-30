/**
 * THE PHONE HEADER'S NAME IS SHOWN ONLY WHEN IT FITS, AND "FITS" IS MEASURED.
 *
 * It used to be a container query at 8rem - the name's width at the default text size. Android's
 * WebView scales font sizes with the system text size and leaves `rem` lengths alone, so at 200 %
 * the query kept saying "it fits" and the name ran over the `+` beside it (Mi 9T, 2026-09-30).
 * jsdom lays nothing out, so the widths are stubbed: what these pin is the DECISION made from them.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import CanariBrand from './CanariBrand.svelte';

let roomWidth = 0;
let nameWidth = 0;
let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  // The room is the brand's parent; the name block is the only element whose scrollWidth is read.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => roomWidth);
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => nameWidth);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ width: 40 }) as DOMRect
  );
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function nameBlock(): HTMLElement {
  const name = [...host.querySelectorAll('p')].find((p) => p.textContent?.trim() === 'Canari');
  if (!name?.parentElement) throw new Error('brand name not rendered');
  return name.parentElement;
}

describe('CanariBrand fitContainer', () => {
  it('shows the name when bird, gap and name fit in the room', () => {
    roomWidth = 200;
    nameWidth = 127;
    component = mount(CanariBrand, { target: host, props: { fitContainer: true, subtitle: '' } });
    flushSync();
    expect(nameBlock().classList.contains('invisible')).toBe(false);
    expect(nameBlock().getAttribute('aria-hidden')).toBeNull();
  });

  it('leaves the bird alone when the name has grown past the room (200 % text)', () => {
    roomWidth = 176;
    nameWidth = 146;
    component = mount(CanariBrand, { target: host, props: { fitContainer: true, subtitle: '' } });
    flushSync();
    expect(nameBlock().classList.contains('invisible')).toBe(true);
    expect(nameBlock().getAttribute('aria-hidden')).toBe('true');
  });

  it('never hides the name of a brand that does not ask to fit', () => {
    roomWidth = 10;
    nameWidth = 146;
    component = mount(CanariBrand, { target: host, props: { subtitle: '' } });
    flushSync();
    expect(nameBlock().classList.contains('invisible')).toBe(false);
  });
});
