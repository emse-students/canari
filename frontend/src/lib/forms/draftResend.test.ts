/**
 * THE CREATE A RESEND SENDS NAMES WHAT THE PAGE SENT (owner, 2026-11-09). A draft's association
 * stays the builder's choice after its first autosave, so a device copy's document may name another
 * association than the create the page already sent; the create is idempotent on its key, and a
 * replay naming another association is refused `FORM_CREATE_KEY_REUSED` - so the replay names the
 * one the copy recorded, and the revision carries the new choice.
 */
import { describe, expect, it } from 'vitest';
import { createAssociationOf } from './draftResend';
import type { FormDraftCopy } from './draftCopies';

const copy = (over: Partial<FormDraftCopy>): FormDraftCopy => ({
  key: 'create-key',
  formId: null,
  clientCreateId: 'create-key',
  baseRevision: 0,
  saveId: 's1',
  after: [],
  document: { title: 'Gala', basePrice: 0, currency: 'eur', items: [], associationId: 'a2' },
  ...over,
});

describe('createAssociationOf', () => {
  it('names the association the create was sent with, not the latest choice', () => {
    expect(createAssociationOf(copy({ createAssociationId: 'a1' }))).toBe('a1');
  });

  it('names none when the create was sent for none, whatever the document says', () => {
    expect(createAssociationOf(copy({ createAssociationId: '' }))).toBe('');
  });

  it("reads a copy kept before the record from its document: that build's create named it", () => {
    expect(createAssociationOf(copy({}))).toBe('a2');
  });
});
