/**
 * THE IN-APP DATE FIELD - a draft until "Valider", in the native input's own value format.
 *
 * Pinned: a day and a time picked reach the caller as `YYYY-MM-DDTHH:mm`; closing without
 * validating changes nothing (cancelling the native dialog did not either); "Effacer" empties an
 * optional date; Escape closes the field without reaching a modal listening on the window.
 */
import { it, expect, afterEach, afterAll, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import DateTimeField from './DateTimeField.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function mountField(props: Record<string, unknown>) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('40rem'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  const target = document.createElement('div');
  document.body.appendChild(target);
  const onValueChange = vi.fn();
  const component = mount(DateTimeField, {
    target,
    props: { label: 'Date limite', value: '', onValueChange, ...props },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return { onValueChange, trigger: target.querySelector('button')! };
}

async function open(trigger: HTMLButtonElement) {
  trigger.click();
  flushSync();
  await tick();
}

function buttonByText(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === text
  );
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

it('hands the picked day and time to the caller in the native format', async () => {
  const { trigger, onValueChange } = mountField({ value: '2026-09-29T20:05' });
  await open(trigger);

  buttonByText('30', document.querySelector('.grid')!).click();
  const hours = document.querySelector('[role="group"][aria-label]')!;
  buttonByText('09', hours).click();
  flushSync();
  buttonByText('Valider').click();
  flushSync();

  expect(onValueChange).toHaveBeenCalledWith('2026-09-30T09:05');
});

it('changes nothing when it is closed without validating', async () => {
  const { trigger, onValueChange } = mountField({ value: '2026-09-29T20:05' });
  await open(trigger);

  buttonByText('30', document.querySelector('.grid')!).click();
  document
    .querySelector('[role="dialog"]')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  flushSync();

  expect(onValueChange).not.toHaveBeenCalled();
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

it('keeps Escape from reaching a modal that listens on the window', async () => {
  const windowEscape = vi.fn();
  window.addEventListener('keydown', windowEscape);
  const { trigger } = mountField({ value: '' });
  await open(trigger);

  document
    .querySelector('[role="dialog"]')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  expect(windowEscape).not.toHaveBeenCalled();
  window.removeEventListener('keydown', windowEscape);
});

it('empties an optional date on "Effacer"', async () => {
  const { trigger, onValueChange } = mountField({ value: '2026-09-29T20:05', clearable: true });
  await open(trigger);

  buttonByText('Effacer').click();

  expect(onValueChange).toHaveBeenCalledWith('');
});
