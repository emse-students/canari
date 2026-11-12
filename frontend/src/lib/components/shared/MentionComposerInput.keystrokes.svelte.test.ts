// @vitest-environment happy-dom
/**
 * TYPING AN `@` IN A CONVERSATION MUST NOT LOOP THE PICKER'S EFFECT (Android 1.6.6, 2026-11-12).
 *
 * The report: in a DM or a salon, typing "salut @" - or "a@b." - replaced the chat with its error
 * boundary, and the log read `GET /api/users/me/blocks`, then `effect_update_depth_exceeded`. The
 * caret reaching an `@` changes `start`, which re-runs the effect that follows the roster prop
 * (`refreshRoster`); on 1.6.6 `suggestLocally` wrote `suggestions` and read it straight back to set
 * `open`, so the effect depended on the array it replaced on every run. Fixed by #3233 (`v1.6.9`);
 * this test drives the REAL component, with the real blocks read and the real name batch answered
 * asynchronously by a fake fetch - the shape of the reporter's log - one keystroke at a time.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MentionComposerInput from './MentionComposerInput.svelte';
import { flushMacrotask, settleUntilStable } from '../../../test/flush';

const ME = 'a'.repeat(64);
const NAMED = 'b'.repeat(64);
const UNNAMED = 'c'.repeat(64);

/** Every request the component made, by path, so the test can say the async answers really ran. */
const asked: string[] = [];

vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(async (url: string) => {
    asked.push(new URL(url, 'https://x.invalid').pathname);
    // An answer that lands on a LATER turn, like the network's.
    await flushMacrotask();
    if (url.includes('/api/users/me/blocks')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (url.includes('/api/users/batch')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          users: [{ id: UNNAMED, firstName: 'Camille', lastName: 'Exemple' }],
          deleted: [],
        }),
      };
    }
    if (url.includes('/api/users/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: NAMED, displayName: 'Bob Exemple' }],
      };
    }
    return { ok: true, status: 200, json: async () => [] };
  }),
}));
vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => ME }));

const errors: unknown[] = [];
function onError(e: ErrorEvent | PromiseRejectionEvent) {
  errors.push('error' in e ? e.error : e.reason);
}

beforeEach(() => {
  asked.length = 0;
  errors.length = 0;
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onError);
});

afterEach(() => {
  window.removeEventListener('error', onError);
  window.removeEventListener('unhandledrejection', onError);
  document.body.innerHTML = '';
});

/** Appends one character at the end of the editor and fires the `input` the browser would. */
function typeChar(editor: HTMLElement, ch: string) {
  editor.textContent = (editor.textContent ?? '') + ch;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  flushSync();
}

/** Waits until the requests, the picker and the errors stop moving (a quiet, not a duration). */
async function settle() {
  await settleUntilStable(
    () =>
      `${asked.length}|${errors.length}|${document.querySelectorAll('[data-mention-suggestion]').length}`
  );
  flushSync();
}

function mountComposer() {
  const target = document.createElement('div');
  document.body.append(target);
  const app = mount(MentionComposerInput, {
    target,
    props: {
      mentionRoster: [{ id: NAMED, displayName: 'Bob Exemple' }, { id: UNNAMED }],
    },
  });
  flushSync();
  const editor = target.querySelector<HTMLElement>('[role="textbox"]')!;
  return { app, target, editor };
}

it('types "salut @" one key at a time: the picker opens, nothing loops', async () => {
  const { app, target, editor } = mountComposer();
  for (const ch of 'salut @') typeChar(editor, ch);
  await settle();
  expect(errors).toEqual([]);
  expect(asked).toContain('/api/users/me/blocks');
  expect(asked).toContain('/api/users/batch');
  // Both members are offered once the batch named the second one.
  expect(target.querySelectorAll('[data-mention-suggestion]').length).toBe(2);
  unmount(app);
});

it('types "a@b." one key at a time: the picker opens on "b", closes on ".", nothing loops', async () => {
  const { app, target, editor } = mountComposer();
  for (const ch of 'a@b') typeChar(editor, ch);
  await settle();
  expect(target.querySelectorAll('[data-mention-suggestion]').length).toBe(1);
  typeChar(editor, '.');
  await settle();
  expect(errors).toEqual([]);
  expect(target.querySelectorAll('[data-mention-suggestion]').length).toBe(0);
  unmount(app);
});

it('pastes "salut @" in one go: the text lands and nothing loops', async () => {
  const { app, editor } = mountComposer();
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  const data = new DataTransfer();
  data.setData('text/plain', 'salut @');
  editor.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
  );
  flushSync();
  await settle();
  expect(errors).toEqual([]);
  expect(editor.textContent).toBe('salut @');
  unmount(app);
});

it('with no roster, a mention ended before its search ran sends no search and opens nothing', async () => {
  const target = document.createElement('div');
  document.body.append(target);
  vi.useFakeTimers();
  const app = mount(MentionComposerInput, { target, props: {} });
  flushSync();
  const editor = target.querySelector<HTMLElement>('[role="textbox"]')!;
  // "." lands well inside the search's 250 ms wait: the mention is over before it would run.
  for (const ch of 'a@b.') typeChar(editor, ch);
  // Past the search's 250 ms wait, on the simulated clock.
  vi.advanceTimersByTime(300);
  vi.useRealTimers();
  await settle();
  expect(errors).toEqual([]);
  expect(asked).not.toContain('/api/users/search');
  expect(target.querySelectorAll('[data-mention-suggestion]').length).toBe(0);
  unmount(app);
});
