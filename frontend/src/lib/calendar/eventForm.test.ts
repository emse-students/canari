import { describe, expect, it } from 'vitest';
import {
  blankEventFormValues,
  eventFormValuesFrom,
  toCreatePayload,
  toDatetimeLocalValue,
  toUpdatePayload,
  validateEventForm,
  type EventFormValues,
} from './eventForm';

/**
 * WHAT A SURFACE MAY DECIDE IS A CAPABILITY, AND THE PAYLOAD IS WHERE IT BECOMES REAL.
 *
 * Four modals became one component. The risk that fusion introduces is not a missing input - that
 * is visible - it is a field the merged form HOLDS and sends from a surface that never offered it.
 * `linkedFormId: null` detaches a registration form; sending it from the global agenda, whose form
 * has no such input and therefore holds `''`, would silently clear a link the association's own
 * page had set. These cases pin that an unseen field is never written.
 */
const BASE: EventFormValues = {
  title: '  Gala  ',
  description: '  a night  ',
  start: '2026-10-06T18:00',
  end: '2026-10-06T23:00',
  kind: 'break',
  linkedFormId: 'form-1',
  coOwnerIds: ['asso-2'],
  targetAssociationId: 'asso-1',
};

describe('validateEventForm', () => {
  it('asks for an association first, but only where one is chosen', () => {
    const noTarget = { ...BASE, targetAssociationId: '' };

    expect(validateEventForm(noTarget, { canTargetAnotherAssociation: true }).ok).toBe(false);
    // The association page files under itself; an empty target there is not a refusal.
    expect(validateEventForm(noTarget, {}).ok).toBe(true);
  });

  it('refuses an empty title and an empty start', () => {
    expect(validateEventForm({ ...BASE, title: '   ' }, {}).ok).toBe(false);
    expect(validateEventForm({ ...BASE, start: '' }, {}).ok).toBe(false);
  });

  it('accepts a complete form', () => {
    expect(validateEventForm(BASE, { canTargetAnotherAssociation: true }).ok).toBe(true);
  });
});

describe('toCreatePayload', () => {
  it('omits kind and linkedFormId for a surface that offers neither', () => {
    const payload = toCreatePayload(BASE, {});

    expect('kind' in payload).toBe(false);
    expect('linkedFormId' in payload).toBe(false);
  });

  it('carries them for a surface that does', () => {
    const payload = toCreatePayload(BASE, { canSetKind: true, canLinkForm: true });

    expect(payload.kind).toBe('break');
    expect(payload.linkedFormId).toBe('form-1');
  });

  it('trims, and sends no end when the field is blank', () => {
    const payload = toCreatePayload({ ...BASE, end: '   ' }, {});

    expect(payload.title).toBe('Gala');
    expect(payload.description).toBe('a night');
    expect(payload.endsAt).toBeUndefined();
    expect(payload.startsAt).toBe(new Date('2026-10-06T18:00').toISOString());
  });
});

describe('toUpdatePayload', () => {
  it('NEVER sends linkedFormId from a surface that cannot see it', () => {
    // The regression this whole file exists for: `null` here detaches a registration form.
    const payload = toUpdatePayload({ ...BASE, linkedFormId: '' }, {});

    expect('linkedFormId' in payload).toBe(false);
  });

  it('detaches when the owning surface clears the field', () => {
    const payload = toUpdatePayload({ ...BASE, linkedFormId: '' }, { canLinkForm: true });

    expect(payload.linkedFormId).toBeNull();
  });

  it('leaves kind alone for a surface that cannot set it', () => {
    // Harmless today, since the server gates on the value CHANGING rather than being sent - but a
    // surface with no kind control resending one is a claim it has no business making.
    expect('kind' in toUpdatePayload(BASE, {})).toBe(false);
    expect(toUpdatePayload(BASE, { canSetKind: true }).kind).toBe('break');
  });
});

describe('toDatetimeLocalValue', () => {
  it("renders an instant in the viewer's own zone, zero-padded", () => {
    // Both surfaces carried this, so both could have drifted. It is the viewer's LOCAL clock that
    // an input shows, which is why the expectation is built from the same Date rather than written
    // as a literal - a literal would assert the runner's timezone, which is not the rule.
    const d = new Date(2026, 8, 3, 7, 5);

    expect(toDatetimeLocalValue(d.toISOString())).toBe('2026-09-03T07:05');
  });
});

describe('blankEventFormValues', () => {
  it('opens on a whole hour with nothing else decided', () => {
    const v = blankEventFormValues();

    expect(v.start.endsWith(':00')).toBe(true);
    expect(v).toMatchObject({
      title: '',
      description: '',
      end: '',
      kind: 'event',
      linkedFormId: '',
      coOwnerIds: [],
      targetAssociationId: '',
    });
  });
});

describe('eventFormValuesFrom', () => {
  const EVENT = {
    associationId: 'asso-1',
    title: 'Gala',
    description: null,
    startsAt: new Date(2026, 9, 6, 18, 30).toISOString(),
    endsAt: null,
    kind: 'break' as const,
    linkedFormId: 'form-9',
    coOwners: [{ associationId: 'asso-2' }],
  };

  it('seeds EVERY field, including ones this surface will not render', () => {
    // A capability decides what is SHOWN and what is SENT. Neither is a reason to forget what the
    // event already holds: the agenda edits an event whose `kind` is `break` without offering the
    // control, and dropping the value here is how an unseen field comes back wrong.
    const v = eventFormValuesFrom(EVENT);

    expect(v).toMatchObject({
      title: 'Gala',
      description: '',
      start: '2026-10-06T18:30',
      end: '',
      kind: 'break',
      linkedFormId: 'form-9',
      coOwnerIds: ['asso-2'],
      targetAssociationId: 'asso-1',
    });
  });

  it('names the owning association, which is what keeps it out of its own co-owner list', () => {
    expect(eventFormValuesFrom(EVENT).targetAssociationId).toBe('asso-1');
  });
});
