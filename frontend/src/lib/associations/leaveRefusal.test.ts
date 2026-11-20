import { describe, expect, it } from 'vitest';
import { LEAVE_REFUSAL, SocialApiError } from './api';
import { leaveRefusalMessage } from './leaveRefusal';
import { m } from '$lib/paraglide/messages';

describe('the "Quitter" refusal is read from its code, never from its message', () => {
  it('names the last member manager, in the reader language', () => {
    const err = new SocialApiError('French prose', LEAVE_REFUSAL.LAST_MEMBER_MANAGER, 400);
    expect(leaveRefusalMessage(err)).toBe(m.asso_leave_last_manager());
  });

  it('names the Lydia Responsable, who hands the role over first (owner, 2026-11-19)', () => {
    const err = new SocialApiError('English prose', LEAVE_REFUSAL.RESPONSABLE_MUST_HAND_OVER, 409);
    expect(leaveRefusalMessage(err)).toBe(m.asso_leave_lydia_responsable());
  });

  it('answers null for anything else, so the caller keeps its generic error', () => {
    expect(leaveRefusalMessage(new SocialApiError('dernier administrateur', null, 400))).toBeNull();
    expect(leaveRefusalMessage(new SocialApiError('x', 'SOMETHING_ELSE', 400))).toBeNull();
    expect(leaveRefusalMessage(new Error('x'))).toBeNull();
  });
});
