// @vitest-environment happy-dom
/**
 * A QUESTION CARD HANDS ITS ANSWER BACK - the one thing moving it out of the page could break.
 *
 * Inline, every input bound straight to `selections[item.id]`. Behind a component the binding goes
 * through a `$bindable` prop, and for a choice list and a matrix through `bind:group` on it: an
 * answer that stays in the card and never reaches the page would still render perfectly. So each
 * type is clicked here and the value the PARENT holds is what is asserted.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { uploadFormAnswerFile, type FormItem } from '$lib/forms/api';
import { UploadAbortedError, type XhrUploadOptions } from '$lib/utils/uploadXhr';
import { m } from '$lib/paraglide/messages';
import FormQuestionHarness from './FormQuestionHarness.test.svelte';

vi.mock('$lib/forms/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/forms/api')>()),
  uploadFormAnswerFile: vi.fn(),
}));

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(item: FormItem, value: unknown, extra: Record<string, unknown> = {}) {
  const state = { value };
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(FormQuestionHarness, {
    target,
    props: { item, initial: value, onChange: (v: unknown) => (state.value = v), ...extra },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return { target, state };
}

const choice = (type: string): FormItem => ({
  id: 'q',
  label: 'Menu',
  required: true,
  type,
  options: [
    { id: 'a', label: 'A', priceModifier: 0 },
    { id: 'b', label: 'B', priceModifier: 250 },
  ],
});

describe('FormQuestion', () => {
  it('hands a typed answer back to the page', () => {
    const { target, state } = render(
      { id: 'q', label: 'Nom', required: true, type: 'short_text' },
      ''
    );
    const input = target.querySelector('input')!;
    input.value = 'Ada';
    input.dispatchEvent(new Event('input'));
    flushSync();
    expect(state.value).toBe('Ada');
  });

  it('hands a single choice back', () => {
    const { target, state } = render(choice('single_choice'), '');
    target.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click();
    flushSync();
    expect(state.value).toBe('b');
  });

  it('hands every ticked option of a multiple choice back', () => {
    const { target, state } = render(choice('multiple_choice'), []);
    for (const box of target.querySelectorAll<HTMLInputElement>('input[type=checkbox]'))
      box.click();
    flushSync();
    expect(state.value).toEqual(['a', 'b']);
  });

  it('hands a matrix row back', () => {
    const item: FormItem = { ...choice('matrix_single'), rows: ['r1'] };
    const { target, state } = render(item, { r1: '' });
    target.querySelectorAll<HTMLInputElement>('input[type=radio]')[0].click();
    flushSync();
    expect(state.value).toEqual({ r1: 'a' });
  });

  it('shows the supplement the page says an option adds, and none the page withholds', () => {
    const { target } = render(choice('single_choice'), '');
    expect(target.textContent).toContain('2,50');
    const priced = render(choice('single_choice'), '', { optionModifier: () => 0 });
    expect(priced.target.textContent).not.toContain('2,50');
  });

  it('refuses a closed option', () => {
    const { target } = render(choice('single_choice'), '', {
      optionClosed: (opt: { id?: string }) => opt.id === 'b',
    });
    expect(target.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].disabled).toBe(true);
  });
});

/**
 * A FILE question while its file travels: the page is told it is busy (so it holds the send), the
 * bar moves, and a cancel ends it with no error and no answer.
 */
describe('FormQuestion - a file on its way', () => {
  const fileItem: FormItem = { id: 'cv', label: 'CV', required: false, type: 'file' };

  function pick(target: HTMLElement, file: File) {
    const input = target.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    // Bubbling: Svelte delegates `change` to the root, as a browser's own event would reach it.
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** An upload that only ends when the test says so, or when its signal aborts. */
  function pendingUpload() {
    let transport: XhrUploadOptions = {};
    let finish: (v: unknown) => void = () => {};
    vi.mocked(uploadFormAnswerFile).mockImplementation((_f, _i, _file, t = {}) => {
      transport = t;
      return new Promise((resolve, reject) => {
        finish = resolve as (v: unknown) => void;
        t.signal?.addEventListener('abort', () => reject(new UploadAbortedError('cancelled')));
      });
    });
    return { transport: () => transport, finish: (v: unknown) => finish(v) };
  }

  it('tells the page it is busy, shows the progress, and hands the id back when done', async () => {
    const upload = pendingUpload();
    const busy: boolean[] = [];
    const { target, state } = render(fileItem, '', {
      onUploadingChange: (b: boolean) => busy.push(b),
    });
    pick(target, new File(['x'], 'cv.pdf', { type: '' }));
    flushSync();
    expect(busy.at(-1)).toBe(true);
    upload.transport().onProgress?.({ loaded: 50, total: 100 } as never);
    flushSync();
    expect(target.textContent).toContain('50');
    upload.finish({ fileId: 'file-1', fileName: 'cv.pdf', sizeBytes: 1, contentType: '' });
    await tick();
    await tick();
    flushSync();
    expect(state.value).toBe('file-1');
    expect(busy.at(-1)).toBe(false);
  });

  it('cancels: no answer, no error, and the page is told it is free again', async () => {
    pendingUpload();
    const busy: boolean[] = [];
    const { target, state } = render(fileItem, '', {
      onUploadingChange: (b: boolean) => busy.push(b),
    });
    pick(target, new File(['x'], 'cv.pdf', { type: 'application/pdf' }));
    flushSync();
    const cancel = [...target.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === m.form_file_cancel()
    )!;
    cancel.click();
    await tick();
    await tick();
    flushSync();
    expect(state.value).toBe('');
    expect(target.querySelector('[role=alert]')).toBeNull();
    expect(busy.at(-1)).toBe(false);
  });

  it('refuses a HEIC photo before anything is sent', () => {
    vi.mocked(uploadFormAnswerFile).mockClear();
    const { target } = render(fileItem, '');
    pick(target, new File(['x'], 'IMG_1.HEIC', { type: 'image/heic' }));
    flushSync();
    expect(target.querySelector('[role=alert]')?.textContent).toBe(m.form_file_error_heic());
    expect(uploadFormAnswerFile).not.toHaveBeenCalled();
  });
});
