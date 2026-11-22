// @vitest-environment happy-dom
/**
 * A TEXT OR IMAGE BLOCK ON THE FILL PAGE (`FormBlock`), and what an OLDER build does with one.
 *
 * Both fill pages (`/forms/:id`, `/f/:id`) draw a block with `FormBlock` and every other item with
 * `FormQuestion`. An app released before blocks draws every item with `FormQuestion`: the block's
 * text and picture are fields a question already had, and its type is one that build does not know
 * - the "update the app" line - while, never required, it holds no send back.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { FormItem } from '$lib/forms/api';
import { m } from '$lib/paraglide/messages';
import FormBlock from './FormBlock.svelte';
import FormQuestionHarness from './FormQuestionHarness.test.svelte';
import { firstMissingAnswer, initialSelections, visibleAnswers } from '$lib/forms/fillAnswers';
import { questionNumbers } from '$lib/forms/formBlocks';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function mountIn(component: any, props: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(component, { target, props });
  mounted.push(() => unmount(instance));
  flushSync();
  return target;
}

const IMAGE = '/api/media/public/11111111-1111-4111-8111-111111111111';
const text: FormItem = {
  id: 'b1',
  type: 'text_block',
  label: 'Programme',
  description: '**Samedi** : rando\nDimanche : repos',
  required: false,
};
const image: FormItem = {
  id: 'b2',
  type: 'image_block',
  label: 'Affiche du gala',
  imageUrl: IMAGE,
  required: false,
};
const name: FormItem = { id: 'q1', type: 'short_text', label: 'Nom', required: true };

describe('FormBlock', () => {
  it('draws a heading and the paragraph in the form description Markdown, and no input', () => {
    const target = mountIn(FormBlock, { item: text, formTitle: 'Week-end' });
    expect(target.querySelector('h2')?.textContent?.trim()).toBe('Programme');
    expect(target.querySelector('strong')?.textContent).toBe('Samedi');
    expect(target.querySelector('br')).not.toBeNull();
    expect(target.querySelector('input, textarea, select')).toBeNull();
  });

  it('draws an image whole with its caption, its alt the caption when none was typed', () => {
    const target = mountIn(FormBlock, { item: image, formTitle: 'Gala' });
    const img = target.querySelector('img')!;
    expect(img.getAttribute('src')).toContain('11111111-1111-4111-8111-111111111111');
    expect(img.getAttribute('alt')).toBe('Affiche du gala');
    expect(img.className).toContain('object-contain');
    expect(target.querySelector('figcaption')?.textContent?.trim()).toBe('Affiche du gala');
  });

  it('never leaves an image without alt: the typed one, else the form named', () => {
    const typed = mountIn(FormBlock, {
      item: { ...image, imageAlt: 'Logo du BDE', label: '' },
      formTitle: 'Gala',
    });
    expect(typed.querySelector('img')!.getAttribute('alt')).toBe('Logo du BDE');
    const bare = mountIn(FormBlock, { item: { ...image, label: '' }, formTitle: 'Gala' });
    expect(bare.querySelector('img')!.getAttribute('alt')).toBe(
      m.form_block_image_alt_default({ title: 'Gala' })
    );
  });
});

describe('the fill logic around a block', () => {
  it('holds no selection, sends no answer, demands nothing, and numbers questions only', () => {
    const items = [text, name, image];
    const selections = initialSelections(items);
    expect(Object.keys(selections)).toEqual(['q1']);
    selections.q1 = 'Ada';
    expect(visibleAnswers(items, { ...selections, b1: 'stale' })).toEqual({ q1: 'Ada' });
    expect(firstMissingAnswer(items, selections, true)).toBeNull();
    expect([...questionNumbers(items)]).toEqual([['q1', 1]]);
  });
});

describe('an older build, which draws every item as a question', () => {
  it('shows the block text and image with the update line, and holds no send back', () => {
    const target = mountIn(FormQuestionHarness, {
      item: { ...image, description: 'Venez nombreux' },
      initial: '',
      onChange: () => undefined,
    });
    expect(target.textContent).toContain('Affiche du gala');
    expect(target.textContent).toContain('Venez nombreux');
    expect(target.querySelector('img')).not.toBeNull();
    expect(target.textContent).toContain(m.form_view_update_app_to_answer());
    // The rule an older build applies: an unknown type blocks the send only when required.
    expect(firstMissingAnswer([{ ...text, type: 'some_future_block' }], {}, true)).toBeNull();
  });
});
