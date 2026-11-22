import { BadRequestException } from '@nestjs/common';
import { FORM_BLOCK_INVALID } from './answer-bounds';
import {
  isFormBlock,
  normaliseFormBlocks,
  questionItemsOf,
  withoutBlockAnswers,
} from './form-blocks';

const IMAGE = '/api/media/public/11111111-1111-4111-8111-111111111111';
const text = (over: Record<string, unknown> = {}) => ({
  id: 'b_text',
  type: 'text_block',
  label: 'Programme',
  description: '**Samedi** : rando',
  required: false,
  ...over,
});
const image = (over: Record<string, unknown> = {}) => ({
  id: 'b_img',
  type: 'image_block',
  label: 'Affiche',
  imageUrl: IMAGE,
  imageAlt: "L'affiche du gala",
  required: false,
  ...over,
});
const question = (over: Record<string, unknown> = {}) => ({
  id: 'q1',
  type: 'single_choice',
  label: 'Menu',
  required: true,
  options: [{ id: 'o1', label: 'Veg', priceModifier: 0 }],
  ...over,
});

/** The body of the 400 `run` refuses with, or null when it did not throw a 400. */
function refusal(run: () => unknown): { code: string; itemId?: string } | null {
  try {
    run();
    return null;
  } catch (e) {
    return e instanceof BadRequestException
      ? (e.getResponse() as { code: string; itemId?: string })
      : null;
  }
}

describe('form blocks', () => {
  it('tells a block from a question', () => {
    expect(isFormBlock(text())).toBe(true);
    expect(isFormBlock(image())).toBe(true);
    expect(isFormBlock(question())).toBe(false);
    expect(questionItemsOf([text(), question(), image()]).map((i) => i.id)).toEqual(['q1']);
  });

  describe('normaliseFormBlocks', () => {
    it('keeps a block to the fields a block has, and a question untouched', () => {
      const q = question();
      const out = normaliseFormBlocks([
        // What an older editor adds to every card it draws: inert, dropped.
        text({ options: [], rows: [], scale: { min: 1, max: 5 }, requireEveryRow: false }),
        q,
        image(),
      ]);
      expect(out[0]).toEqual({
        id: 'b_text',
        type: 'text_block',
        label: 'Programme',
        description: '**Samedi** : rando',
        required: false,
      });
      expect(out[1]).toBe(q);
      expect(out[2]).toEqual({
        id: 'b_img',
        type: 'image_block',
        label: 'Affiche',
        imageUrl: IMAGE,
        imageAlt: "L'affiche du gala",
        required: false,
      });
    });

    it('accepts a heading alone, a paragraph alone, and an image with no caption', () => {
      expect(() =>
        normaliseFormBlocks([
          text({ description: undefined }),
          text({ id: 'b2', label: '' }),
          image({ label: '', imageAlt: undefined }),
        ])
      ).not.toThrow();
    });

    it.each([
      ['required', text({ required: true })],
      ['options', text({ options: [{ label: 'A', priceModifier: 0 }] })],
      ['rows', image({ rows: ['Vert'] })],
      ['a priced grid', text({ productGrid: { rows: [] } })],
      ['a condition', text({ showIf: { answer: { questionId: 'q1', optionIds: ['o1'] } } })],
      ['a legacy condition', image({ dependsOn: 'q1', dependsValue: 'o1' })],
      ['no text', text({ label: ' ', description: '' })],
      ['no image', image({ imageUrl: '' })],
      ['a label that is not text', text({ label: 42 })],
    ])('refuses a block carrying %s', (_why, block) => {
      expect(refusal(() => normaliseFormBlocks([question(), block]))).toEqual(
        expect.objectContaining({ code: FORM_BLOCK_INVALID, itemId: block.id })
      );
    });

    it('refuses a question whose condition names a block', () => {
      const dependent = question({
        id: 'q2',
        showIf: { answer: { questionId: 'b_text', optionIds: ['x'] } },
      });
      expect(refusal(() => normaliseFormBlocks([text(), dependent]))).toEqual(
        expect.objectContaining({ code: FORM_BLOCK_INVALID, itemId: 'q2' })
      );
      const legacy = question({ id: 'q3', dependsOn: 'b_img', dependsValue: 'x' });
      expect(refusal(() => normaliseFormBlocks([image(), legacy]))).toEqual(
        expect.objectContaining({ code: FORM_BLOCK_INVALID, itemId: 'q3' })
      );
    });
  });

  describe('form-level references to a block', () => {
    it('refuses a submit condition naming a block', () => {
      const refs = { submitCondition: { answer: { questionId: 'b_text', optionIds: ['x'] } } };
      expect(refusal(() => normaliseFormBlocks([text(), question()], refs))).toEqual(
        expect.objectContaining({ code: FORM_BLOCK_INVALID, itemId: 'b_text' })
      );
    });

    it('refuses a price-grid answer dimension naming a block, and lets a question one through', () => {
      const grid = (questionId: string) => ({
        priceMatrix: { dimensions: [{ id: 'd', kind: 'answer', questionId, buckets: [] }] },
      });
      expect(refusal(() => normaliseFormBlocks([image(), question()], grid('b_img')))).toEqual(
        expect.objectContaining({ code: FORM_BLOCK_INVALID, itemId: 'b_img' })
      );
      expect(() => normaliseFormBlocks([image(), question()], grid('q1'))).not.toThrow();
    });
  });

  it('refuses a block label or paragraph over the bound', () => {
    expect(refusal(() => normaliseFormBlocks([{ ...text(), label: 'x'.repeat(501) }]))).toEqual(
      expect.objectContaining({ code: FORM_BLOCK_INVALID })
    );
    expect(
      refusal(() => normaliseFormBlocks([{ ...text(), description: 'x'.repeat(5001) }]))
    ).toEqual(expect.objectContaining({ code: FORM_BLOCK_INVALID }));
  });

  describe('withoutBlockAnswers', () => {
    it('drops a key naming a block and keeps every other one', () => {
      expect(
        withoutBlockAnswers([text(), question()], { b_text: 'x', q1: 'o1', other: 'y' }, 'test')
      ).toEqual({ q1: 'o1', other: 'y' });
    });

    it('returns the same answers when the form holds no block', () => {
      const answers = { q1: 'o1' };
      expect(withoutBlockAnswers([question()], answers, 'test')).toBe(answers);
    });
  });
});
