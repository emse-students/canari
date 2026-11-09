import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import {
  askedGuestFields,
  emptyGuestIdentity,
  firstGuestFieldProblem,
  guestDisplayName,
  guestFieldProblem,
  guestFieldsAdvice,
  guestIdentityPayload,
  payerPromptNeeded,
} from './guestIdentity';

/**
 * A guest is asked only what the form asks (owner, 2026-11-06): nothing by default, each ticked
 * field required, the e-mail never asked twice. The server holds the same rule
 * (`apps/social-service/src/forms/guest-identity.ts`); this is the page's half.
 */
describe('guest identity', () => {
  it('reads the asked fields in page order, and nothing from null', () => {
    expect(askedGuestFields(null)).toEqual([]);
    expect(askedGuestFields(['email', 'lastName', 'phone'])).toEqual(['lastName', 'email']);
  });

  it('requires an asked field and checks the e-mail shape', () => {
    expect(guestFieldProblem('lastName', '  ')).toBe(m.form_guest_identity_required());
    expect(guestFieldProblem('email', 'nope')).toBe(m.payer_email_invalid());
    expect(guestFieldProblem('email', 'marie@x.fr')).toBeNull();
    const values = { ...emptyGuestIdentity(), lastName: 'Curie' };
    expect(firstGuestFieldProblem(['lastName', 'email'], values)).toBe('email');
    expect(firstGuestFieldProblem([], emptyGuestIdentity())).toBeNull();
  });

  it('sends only the asked fields, trimmed', () => {
    const values = { lastName: ' Curie ', firstName: 'Marie', email: 'marie@x.fr' };
    expect(guestIdentityPayload(['lastName'], values)).toEqual({ guestLastName: 'Curie' });
    expect(guestIdentityPayload([], values)).toEqual({});
  });

  it('asks the payer address only when the form did not ask the e-mail', () => {
    expect(payerPromptNeeded(true, [])).toBe(true);
    expect(payerPromptNeeded(true, ['email'])).toBe(false);
    expect(payerPromptNeeded(false, [])).toBe(false);
  });

  it('suggests asking on a public form, more firmly when it charges', () => {
    expect(guestFieldsAdvice(false, true, [])).toBe('none');
    expect(guestFieldsAdvice(true, false, [])).toBe('suggested');
    expect(guestFieldsAdvice(true, true, [])).toBe('paid');
    expect(guestFieldsAdvice(true, true, ['email'])).toBe('none');
  });

  it('names a guest by what they gave', () => {
    expect(guestDisplayName({ guestFirstName: 'Marie', guestLastName: 'Curie' })).toBe(
      'Marie Curie'
    );
    expect(guestDisplayName({})).toBeNull();
  });
});
