import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetch = vi.fn();
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://core.test' }));
vi.mock('$lib/utils/Log', () => ({ Log: { d: vi.fn() } }));

import {
  PROFILE_ERROR_CODES,
  ProfileApiError,
  profileErrorMessage,
  readProfileError,
  refuseCorrection,
  requestCorrection,
  saveProfile,
} from './profileEdit';
import { m } from '$lib/paraglide/messages';

const input = {
  campus: 'gardanne' as const,
  cursus: [{ formation: 'ISMIN', promo: 2024 }],
  posts: [],
  firstName: 'Camille',
  lastName: 'Durand',
};

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('profile calls', () => {
  beforeEach(() => apiFetch.mockReset());

  it('PUTs the whole profile to the person, and names the request when it answers one', async () => {
    apiFetch.mockResolvedValue(reply(200, { changed: true }));
    await saveProfile('u 1', input);
    await saveProfile('u 1', input, 'req-1');
    const [direct, answering] = apiFetch.mock.calls;
    expect(direct[0]).toBe('https://core.test/api/users/u%201/profile');
    expect(direct[1].method).toBe('PUT');
    expect(JSON.parse(direct[1].body)).toEqual(input);
    expect(JSON.parse(answering[1].body)).toEqual({ ...input, requestId: 'req-1' });
  });

  it('classifies a refusal by the typed CODE in the body, never by its message', async () => {
    apiFetch.mockResolvedValue(
      reply(403, { code: 'PROFILE_EDIT_DEV_ESTATE', message: 'whatever the server says today' })
    );
    const err = await saveProfile('u', input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProfileApiError);
    expect((err as ProfileApiError).code).toBe('PROFILE_EDIT_DEV_ESTATE');
    expect(profileErrorMessage(err)).toBe(m.profile_edit_error_dev_estate());
  });

  it('a body with an unknown code, or none, is a generic failure and never a guessed one', async () => {
    const unknown = await readProfileError(reply(500, { code: 'SOMETHING_NEW' }));
    const none = await readProfileError(new Response('boom', { status: 502 }));
    expect(unknown.code).toBeNull();
    expect(none.code).toBeNull();
    expect(profileErrorMessage(unknown)).toBe(m.common_generic_error_label());
    expect(profileErrorMessage(new Error('network'))).toBe(m.common_generic_error_label());
  });

  it('every typed code has its own localized sentence', () => {
    const generic = m.common_generic_error_label();
    for (const code of PROFILE_ERROR_CODES) {
      expect(profileErrorMessage(new ProfileApiError(400, code)), code).not.toBe(generic);
    }
  });

  it('files a correction request and refuses one with a note', async () => {
    apiFetch.mockResolvedValueOnce(reply(201, { request: { id: 'r', status: 'pending' } }));
    const request = await requestCorrection('wrong campus');
    expect(request.id).toBe('r');
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ message: 'wrong campus' });

    apiFetch.mockResolvedValueOnce(reply(200, {}));
    await refuseCorrection('r 1', 'not a mistake');
    expect(apiFetch.mock.calls[1][0]).toBe(
      'https://core.test/api/users/admin/profile-corrections/r%201/refuse'
    );
  });

  it('a second open request surfaces as the PENDING code', async () => {
    apiFetch.mockResolvedValue(reply(409, { code: 'PROFILE_CORRECTION_PENDING' }));
    const err = await requestCorrection('again').catch((e: unknown) => e);
    expect((err as ProfileApiError).code).toBe('PROFILE_CORRECTION_PENDING');
  });
});
