// @vitest-environment happy-dom
/**
 * Enter on a focused salon row opened nothing for whoever may reorder salons: the row is the
 * draggable of a `svelte-dnd-action` zone, and the library claims Enter and Space as "start a
 * keyboard drag" (`preventDefault` + `stopPropagation`), which cancels the button's activation.
 * The real library is mounted here, so a version that changes that behaviour is seen.
 */
import { dndzone } from 'svelte-dnd-action';
import { keepRowActivationKeys } from './dndActivationKeys';

function zoneWithRows(guarded: boolean) {
  const zone = document.createElement('div');
  const items = [{ id: 'a' }, { id: 'b' }];
  for (const item of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.textContent = item.id;
    zone.appendChild(row);
  }
  document.body.appendChild(zone);
  const guard = guarded ? keepRowActivationKeys(zone) : null;
  const dnd = dndzone(zone, { items, flipDurationMs: 0, zoneItemTabIndex: -1 });
  return {
    row: zone.children[0] as HTMLButtonElement,
    destroy() {
      dnd.destroy?.();
      guard?.destroy();
      zone.remove();
    },
  };
}

function press(el: Element, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

describe('keepRowActivationKeys', () => {
  it('without it the library cancels Enter on a row (the defect)', () => {
    const { row, destroy } = zoneWithRows(false);
    expect(press(row, { key: 'Enter' }).defaultPrevented).toBe(true);
    destroy();
  });

  it('leaves Enter and Space to the row, so the button activates', () => {
    const { row, destroy } = zoneWithRows(true);
    expect(press(row, { key: 'Enter' }).defaultPrevented).toBe(false);
    expect(press(row, { key: ' ' }).defaultPrevented).toBe(false);
    destroy();
  });

  it('lets every other key through to the row (Alt + arrows reorders)', () => {
    const { row, destroy } = zoneWithRows(true);
    const seen = vi.fn();
    row.addEventListener('keydown', seen);
    press(row, { key: 'ArrowUp', altKey: true });
    press(row, { key: 'Escape' });
    expect(seen).toHaveBeenCalledTimes(2);
    destroy();
  });

  it('never lets a MODIFIED Enter or Space start the library keyboard drag either', () => {
    // The library reads `e.key` and nothing else, so Shift + Enter used to start a silent
    // keyboard drag (its announcements are off here) that the arrows then moved.
    const { row, destroy } = zoneWithRows(true);
    for (const mod of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
      expect(press(row, { key: 'Enter', [mod]: true }).defaultPrevented).toBe(false);
      expect(press(row, { key: ' ', [mod]: true }).defaultPrevented).toBe(false);
    }
    destroy();
  });
});
