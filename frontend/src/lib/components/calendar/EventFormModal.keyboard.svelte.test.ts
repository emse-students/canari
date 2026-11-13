// @vitest-environment happy-dom
/**
 * THE EVENT FORM FROM THE KEYBOARD: it is a dialog like the others (`shared/Modal.svelte`), driven
 * by the same `focusTrap`: Tab stays inside, Escape closes it - and only it - and the focus goes
 * back where it was when it is gone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<typeof import('$lib/associations/api')>()),
  listAssociations: async () => [],
}));

import { setLocale } from '$lib/paraglide/runtime';
import EventFormModal from './EventFormModal.svelte';
import { blankEventFormValues } from '$lib/calendar/eventForm';
import { flushMacrotask } from '../../../test/flush';

const mounted: ReturnType<typeof mount>[] = [];
let opener: HTMLButtonElement;

beforeEach(() => {
  setLocale('en', { reload: false });
  opener = document.createElement('button');
  document.body.appendChild(opener);
  opener.focus();
});
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

async function open(onClose: () => void) {
  const values = $state({ ...blankEventFormValues(), title: 'Perm' });
  mounted.push(
    mount(EventFormModal, {
      target: document.body,
      props: {
        open: true,
        heading: 'New event',
        values,
        submitLabel: 'go',
        savingLabel: 'saving',
        onSubmit: async () => {},
        onClose,
      },
    })
  );
  flushSync();
  await flushMacrotask();
  flushSync();
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;

/** The controls Tab walks, in order - the list `focusTrap` reads. */
const controls = () =>
  Array.from(
    dialog().querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  );

/** A key pressed on `from`, bubbling as the browser delivers one. */
function press(from: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  from.dispatchEvent(event);
  flushSync();
  return event;
}

describe('the event form from the keyboard', () => {
  it('closes on Escape, and the key goes no further than the dialog', async () => {
    const onClose = vi.fn();
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    await open(onClose);

    press(controls()[0], 'Escape');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outside).not.toHaveBeenCalled();
    window.removeEventListener('keydown', outside);
  });

  it('keeps Tab inside: from the last control to the first, and back', async () => {
    await open(() => {});
    const first = controls()[0];
    const last = controls().at(-1)!;
    expect(first).not.toBe(last);

    last.focus();
    expect(press(last, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    expect(press(first, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('ignores a key that is not Escape', async () => {
    const onClose = vi.fn();
    await open(onClose);

    press(controls()[0], 'Enter');

    expect(onClose).not.toHaveBeenCalled();
  });

  it('gives the focus back when it is gone', async () => {
    await open(() => {});
    controls()[0].focus();

    unmount(mounted.pop()!);
    flushSync();

    expect(document.activeElement).toBe(opener);
  });
});
