// @vitest-environment happy-dom
/**
 * TEXT AND IMAGE BLOCKS IN THE EDITOR (owner, 2026-11-21): added from the wizard at once, opened,
 * edited in their card, moved and removed like a question - and never numbered, required or
 * conditioned. Mounted through the section, as the admin pages mount it.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import Harness from './FormQuestionsSectionHarness.test.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import { toFormItemsPayload } from '$lib/forms/itemsPayload';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const IMAGE = '/api/media/public/11111111-1111-4111-8111-111111111111';

function render(initial: any[], extra: Record<string, unknown> = {}) {
  const state = { items: initial as any[] };
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(Harness, {
    target,
    props: { initial, onItems: (i: any[]) => (state.items = i), ...extra },
  });
  mounted.push(() => unmount(component));
  flushSync();
  return { target, state };
}

const allButtons = (t: HTMLElement) => [...t.querySelectorAll<HTMLButtonElement>('button')];
const menuItem = (key: string) =>
  document.querySelector<HTMLButtonElement>(`[data-menu-item="${key}"]`)!;
const addButton = (t: HTMLElement) =>
  allButtons(t).find((b) => b.textContent?.includes(m.form_add_question_button()))!;
const byLabel = (t: HTMLElement, label: string) =>
  t.querySelector<HTMLButtonElement>(`[role="toolbar"] button[aria-label="${label}"]`)!;

function addBlock(t: HTMLElement, kind: 'text_block' | 'image_block') {
  addButton(t).click();
  flushSync();
  menuItem(kind).click();
  flushSync();
}

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

const question = { id: 'q1', type: 'short_text', label: 'Nom', required: true };

describe('adding a block', () => {
  it('inserts a text block at once, opened, unnumbered and with nothing of a question', () => {
    const { target, state } = render([question]);
    addBlock(target, 'text_block');
    // No second step: the wizard is gone and the block is on the list.
    expect(document.querySelector('[data-testid="add-question-wizard"]')).toBeNull();
    expect(state.items.map((i) => i.type)).toEqual(['short_text', 'text_block']);
    expect(state.items[1].required).toBe(false);
    // Opened on its heading, with its paragraph field; no required switch, no conditions.
    const heading = target.querySelector<HTMLInputElement>(
      `input[aria-label="${m.form_block_text_heading_placeholder()}"]`
    )!;
    expect(heading).not.toBeNull();
    expect(byLabel(target, m.form_builder_required_label())).toBeNull();
    expect(target.querySelector('[data-testid="more-options"]')).toBeNull();
    expect(target.querySelector('[data-testid="block-kind"]')).not.toBeNull();
    // Empty: the card says why the save would be refused.
    expect(target.querySelector('[data-testid="block-problem"]')?.textContent).toContain(
      m.form_block_text_empty()
    );
    type(heading, 'Programme');
    const paragraph = target.querySelector<HTMLTextAreaElement>(
      `textarea[aria-label="${m.form_block_text_paragraph_label()}"]`
    )!;
    type(paragraph, '**Samedi** : rando');
    expect(state.items[1]).toMatchObject({ label: 'Programme', description: '**Samedi** : rando' });
    expect(target.querySelector('[data-testid="block-problem"]')).toBeNull();
  });

  it('inserts an image block whose card uploads the picture and asks for its alt', async () => {
    const upload = vi.fn(() => Promise.resolve(IMAGE));
    const { target, state } = render([question], { imageUploadFn: upload });
    addBlock(target, 'image_block');
    expect(state.items[1].type).toBe('image_block');
    expect(target.querySelector('[data-testid="block-problem"]')?.textContent).toContain(
      m.form_block_image_missing()
    );
    const file = new File([new Uint8Array([1, 2, 3])], 'affiche.png', { type: 'image/png' });
    const input = target.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(state.items[1].imageUrl).toBe(IMAGE));
    await tick();
    flushSync();
    const alt = target.querySelector<HTMLInputElement>(
      `input[aria-label="${m.form_builder_image_alt_placeholder()}"]`
    )!;
    type(alt, "L'affiche du gala");
    expect(state.items[1].imageAlt).toBe("L'affiche du gala");
    expect(target.querySelector('[data-testid="block-problem"]')).toBeNull();
  });

  it('is not offered where blocks are not taken (a booking space)', () => {
    const { target } = render([question], { offerBlocks: false });
    addButton(target).click();
    flushSync();
    expect(menuItem('text_block')).toBeNull();
    expect(menuItem('image_block')).toBeNull();
  });

  it('is never offered by a question card type menu', () => {
    const { target } = render([question]);
    allButtons(target)
      .find((b) => b.getAttribute('aria-label')?.includes('Nom'))!
      .click();
    flushSync();
    target.querySelector<HTMLButtonElement>('#type-picker-q1')!.click();
    flushSync();
    expect(menuItem('short_text')).not.toBeNull();
    expect(menuItem('text_block')).toBeNull();
  });
});

describe('a block on the list', () => {
  const block = { id: 'b1', type: 'text_block', label: 'Programme', required: false };

  it('is counted and numbered nowhere: the questions keep 1, 2', () => {
    const second = { id: 'q2', type: 'long_text', label: 'Remarques', required: false };
    const { target } = render([question, block, second]);
    expect(target.textContent).toContain(m.form_questions_count({ count: 2 }));
    const rows = allButtons(target).filter((b) => b.hasAttribute('data-row-button'));
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      m.form_builder_open_question_aria({ n: 1, title: 'Nom' }),
      m.form_block_open_aria({ kind: m.qtype_text_block(), title: 'Programme' }),
      m.form_builder_open_question_aria({ n: 2, title: 'Remarques' }),
    ]);
  });

  it('moves and is removed like a question', () => {
    const { target, state } = render([question, block]);
    allButtons(target)
      .find((b) => b.hasAttribute('data-row-button') && b.textContent?.includes('Programme'))!
      .click();
    flushSync();
    byLabel(target, m.form_builder_move_up_aria()).click();
    flushSync();
    expect(state.items.map((i) => i.id)).toEqual(['b1', 'q1']);
    byLabel(target, m.form_card_menu_aria()).click();
    flushSync();
    menuItem('remove').click();
    flushSync();
    expect(state.items.map((i) => i.id)).toEqual(['q1']);
  });
});

describe('the payload', () => {
  it('sends a block with a block fields alone, whatever the card held', () => {
    const [text, image] = toFormItemsPayload(
      [
        {
          id: 'b1',
          type: 'text_block',
          label: '',
          description: 'Rendez-vous a 8h',
          required: true,
          options: [{ id: 'o', label: 'x' }],
          rows: [],
          scale: { min: 1, max: 5 },
        },
        { id: 'b2', type: 'image_block', label: 'Affiche', imageUrl: IMAGE, imageAlt: ' ' },
      ],
      true
    ) as unknown as Record<string, unknown>[];
    expect(text).toEqual({
      id: 'b1',
      type: 'text_block',
      label: '',
      required: false,
      description: 'Rendez-vous a 8h',
    });
    expect(image).toEqual({
      id: 'b2',
      type: 'image_block',
      label: 'Affiche',
      required: false,
      imageUrl: IMAGE,
    });
  });
});
