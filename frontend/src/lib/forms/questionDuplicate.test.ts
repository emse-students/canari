import { describe, it, expect } from 'vitest';
import { duplicateQuestion, firstQuestionAtFault } from './questionDuplicate';

const base = () => [
  {
    id: 'a',
    type: 'single_choice',
    label: 'A',
    options: [
      { id: 'a1', label: 'one', priceModifier: 100 },
      { id: 'a2', label: 'two' },
    ],
  },
  {
    id: 'b',
    type: 'short_text',
    label: 'B',
    required: true,
    description: 'desc',
    dependsOn: 'a',
    dependsValue: 'a1',
    showIf: { promo: [2027] },
  },
  { id: 'c', type: 'short_text', label: 'C', dependsOn: 'b', dependsValue: 'x' },
];

describe('duplicateQuestion', () => {
  it('inserts the copy right after the original with every field and new ids', () => {
    const items = base();
    const r = duplicateQuestion(items, 0)!;
    expect(r.items.map((q) => q.id)).toEqual(['a', r.copyId, 'b', 'c']);
    const copy = r.items[1];
    expect(copy.id).not.toBe('a');
    expect(copy.label).toBe('A');
    expect(copy.options!.map((o: any) => o.label)).toEqual(['one', 'two']);
    expect((copy.options![0] as any).priceModifier).toBe(100);
    expect(copy.options!.map((o) => o.id)).not.toContain('a1');
    expect(copy.options!.map((o) => o.id)).not.toContain('a2');
  });

  it('keeps required, description, answer and audience conditions on the copy', () => {
    const r = duplicateQuestion(base(), 1)!;
    const copy: any = r.items[2];
    expect(copy.required).toBe(true);
    expect(copy.description).toBe('desc');
    expect(copy.dependsOn).toBe('a');
    expect(copy.dependsValue).toBe('a1');
    expect(copy.showIf).toEqual({ promo: [2027] });
    copy.showIf.promo.push(1);
    expect((r.items[1] as any).showIf.promo).toEqual([2027]);
  });

  it('leaves conditions of other questions pointing at the original', () => {
    const r = duplicateQuestion(base(), 1)!;
    const c: any = r.items.find((q) => q.id === 'c');
    expect(c.dependsOn).toBe('b');
    expect(r.items[1].id).toBe('b');
  });

  it('drops a copy condition that cannot stay valid', () => {
    const items: any[] = base();
    items[1].dependsOn = 'c';
    const copy: any = duplicateQuestion(items, 1)!.items[2];
    expect(copy.dependsOn).toBe('');
    expect(copy.dependsValue).toBe('');
    items[1].dependsOn = 'b';
    expect((duplicateQuestion(items, 1)!.items[2] as any).dependsOn).toBe('');
  });

  it('returns null for an unknown index', () => {
    expect(duplicateQuestion(base(), 9)).toBeNull();
  });
});

describe('firstQuestionAtFault', () => {
  it('names the first empty audience condition, else the file question when asked', () => {
    expect(firstQuestionAtFault([{ id: 'x' }, { id: 'y', showIf: {} }], false)).toBe('y');
    expect(firstQuestionAtFault([{ id: 'x', type: 'file' }], true)).toBe('x');
    expect(firstQuestionAtFault([{ id: 'x', type: 'file' }], false)).toBeNull();
  });
});
