// @vitest-environment happy-dom
/**
 * A QUESTION'S IMAGE IN THE EDITOR (owner, 2026-11-06: "au meme titre qu'une description"): an
 * "Ajouter une image" affordance beside "Ajouter une description", then a thumbnail with replace and
 * remove. What is asserted is the question the PARENT holds - the value the save sends.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import FormBuilderHarness from './FormBuilderHarness.test.svelte';

const URL_A = '/api/media/public/11111111-1111-4111-8111-111111111111';
const URL_B = '/api/media/public/22222222-2222-4222-8222-222222222222';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(initial: Record<string, unknown>, imageUploadFn?: (file: File) => Promise<string>) {
  const state: { item: Record<string, unknown> } = { item: initial };
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(FormBuilderHarness, {
    target,
    props: { initial, onChange: (item) => (state.item = item), imageUploadFn },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return { target, state };
}

const question = (extra: Record<string, unknown> = {}) => ({
  id: 'q',
  label: 'Ton plat',
  type: 'short_text',
  required: false,
  options: [],
  ...extra,
});

/** The visible text of every button and label of the card. */
const affordances = (target: HTMLElement) =>
  [...target.querySelectorAll('button, label')].map((el) => el.textContent?.trim() ?? '');

async function pick(target: HTMLElement, file: File) {
  const input = target.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  for (let i = 0; i < 3; i++) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

describe('FormBuilder - a question image', () => {
  it('offers "add an image" beside "add a description" when an upload is possible, and not otherwise', () => {
    const withUpload = render(question(), () => Promise.resolve(URL_A));
    const row = affordances(withUpload.target);
    expect(row).toContain(m.form_builder_add_desc());
    expect(row).toContain(m.form_builder_add_image());
    const input = withUpload.target.querySelector('input[type=file]') as HTMLInputElement;
    expect(input.accept).toBe('image/jpeg,image/png,image/webp');

    const without = render(question());
    expect(affordances(without.target)).not.toContain(m.form_builder_add_image());
  });

  it('uploads the picked file and stores the URL the server answered on the question', async () => {
    const upload = vi.fn(() => Promise.resolve(URL_A));
    const { target, state } = render(question(), upload);
    const file = new File(['x'], 'menu.jpg', { type: 'image/jpeg' });
    await pick(target, file);
    expect(upload).toHaveBeenCalledWith(file);
    expect(state.item.imageUrl).toBe(URL_A);
    const thumb = target.querySelector('img') as HTMLImageElement;
    expect(thumb.getAttribute('src')).toMatch(/11111111-1111-4111-8111-111111111111$/);
    // The preview shows the whole picture, never a crop.
    expect(thumb.className).toContain('object-contain');
    expect(thumb.className).not.toContain('object-cover');
    expect(affordances(target)).toContain(m.form_builder_replace_image());
  });

  it('replaces the image, and removes it with its alt text', async () => {
    const { target, state } = render(question({ imageUrl: URL_A, imageAlt: 'Le menu' }), () =>
      Promise.resolve(URL_B)
    );
    await pick(target, new File(['y'], 'menu2.png', { type: 'image/png' }));
    expect(state.item.imageUrl).toBe(URL_B);

    const remove = [...target.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === m.form_builder_remove_image_title()
    )!;
    remove.click();
    flushSync();
    expect(state.item.imageUrl).toBeUndefined();
    expect(state.item.imageAlt).toBeUndefined();
    expect(affordances(target)).toContain(m.form_builder_add_image());
  });

  it('says in words why an upload failed, and leaves the question as it was', async () => {
    const { target, state } = render(question(), () => Promise.reject(new Error('Upload failed')));
    await pick(target, new File(['x'], 'menu.jpg', { type: 'image/jpeg' }));
    expect(target.querySelector('[role=alert]')?.textContent).toBe(
      m.form_builder_image_upload_failed()
    );
    expect(state.item.imageUrl).toBeUndefined();
  });
});
