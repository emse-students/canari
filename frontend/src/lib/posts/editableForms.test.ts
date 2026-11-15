import { describe, expect, it, vi } from 'vitest';
import { attachableForms, withAttachedForm } from './editableForms';
import type { Form } from '$lib/forms/api';

const form = (id: string): Form => ({ id, title: `form ${id}`, items: [] }) as unknown as Form;

describe('withAttachedForm', () => {
  it('adds the attached form a reader does not manage, first', async () => {
    const read = vi.fn(async (id: string) => form(id));
    const out = await withAttachedForm([form('mine')], 'theirs', read);
    expect(out.map((f) => f.id)).toEqual(['theirs', 'mine']);
    expect(read).toHaveBeenCalledOnce();
  });

  it('shows the attached form for a reader who manages no form at all', async () => {
    const out = await withAttachedForm([], 'theirs', async (id) => form(id));
    expect(out.map((f) => f.id)).toEqual(['theirs']);
  });

  it('reads nothing when the attached form is already in the list', async () => {
    const read = vi.fn();
    const list = [form('a'), form('b')];
    expect(await withAttachedForm(list, 'b', read)).toBe(list);
    expect(read).not.toHaveBeenCalled();
  });

  it('reads nothing for a post with no form', async () => {
    const read = vi.fn();
    const list = [form('a')];
    expect(await withAttachedForm(list, null, read)).toBe(list);
    expect(await withAttachedForm(list, undefined, read)).toBe(list);
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps the reader list when the attached form cannot be read', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const list = [form('a')];
    const out = await withAttachedForm(list, 'gone', async () => {
      throw new Error('404');
    });
    expect(out).toBe(list);
    expect(err).toHaveBeenCalledOnce();
    err.mockRestore();
  });
});

describe('attachableForms', () => {
  const of = (id: string, associationId?: string): Form =>
    ({ id, title: id, items: [], associationId }) as unknown as Form;
  const forms = [of('a1', 'A'), of('b1', 'B'), of('mine')];

  it("offers an association's post only that association's forms (the server's rule)", () => {
    expect(
      attachableForms(forms, { associationId: 'A', anonymous: false }).map((f) => f.id)
    ).toEqual(['a1']);
    expect(attachableForms(forms, { associationId: 'C', anonymous: false })).toEqual([]);
  });

  it('offers a personal post every form the reader manages', () => {
    expect(attachableForms(forms, { associationId: null, anonymous: false })).toBe(forms);
  });

  it('offers an anonymous post no form: the form would name who manages it', () => {
    expect(attachableForms(forms, { associationId: null, anonymous: true })).toEqual([]);
  });
});
