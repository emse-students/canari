// @vitest-environment happy-dom
/**
 * WHAT THE GATE DOES BETWEEN TWO ATTEMPTS (iPhone 12, `1.2.9-alpha.2`, 2026-10-16).
 *
 * An offline attempt left its six digits in the field, the member typed six more once back online,
 * and the twelve-digit PIN cost a "PIN incorrect". And at the largest text size the keypad's last
 * row and the links under it sit below the scroll region's fold, under the footer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { initHistoryOverlayStack } from '$lib/utils/historyOverlayStack';
import PinModal from './PinModal.svelte';

let stop: () => void;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  stop = initHistoryOverlayStack();
  vi.spyOn(history, 'back').mockImplementation(() => {});
});

afterEach(() => {
  if (app) void unmount(app);
  app = null;
  stop();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function raise() {
  const props = $state({
    open: true,
    pin: '',
    isLoading: false,
    externalError: '',
    onSubmit: vi.fn(),
    onSignOut: vi.fn(),
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  app = mount(PinModal, { target, props });
  flushSync();
  // The keypad is the coarse-pointer default; the text field is what a test can read back.
  const manual = [...document.querySelectorAll('button')].find(
    (b) => b.querySelector('svg') === null && /manuel|manual/i.test(b.textContent ?? '')
  );
  manual?.click();
  flushSync();
  const field = document.getElementById('encryption-pin') as HTMLInputElement;
  return { props, field };
}

function type(field: HTMLInputElement, value: string) {
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

describe('PinModal - an attempt refused with the gate still up', () => {
  // The REFUSAL empties the field, through the bound `pin` the parent clears where it refuses
  // (`refusePinAttempt` in ChatBackgroundService) - never an effect guessing from the spinner.
  it('empties the field when the parent clears the bound PIN, so the next one is not appended', () => {
    const { props, field } = raise();
    type(field, '123456');

    props.pin = '';
    props.externalError = 'server unreachable';
    flushSync();

    expect(field.value).toBe('');
  });

  it('leaves what is being typed alone when the spinner merely comes and goes', () => {
    const { props, field } = raise();
    type(field, '1234');
    props.isLoading = true;
    flushSync();
    props.isLoading = false;
    props.externalError = 'something else';
    flushSync();

    expect(field.value).toBe('1234');
  });
});

describe('PinModal - a control focused in the scroll region is brought into it', () => {
  it('scrolls the focused control into view', () => {
    raise();
    const scrollIntoView = vi.fn();
    const region = document.querySelector('[data-pin-scroll]') as HTMLElement;
    const control = region.querySelector('button') as HTMLButtonElement;
    control.scrollIntoView = scrollIntoView;

    control.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
  });
});
