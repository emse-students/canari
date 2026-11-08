import { describe, expect, it, vi, beforeEach } from 'vitest';

const getPublicForm = vi.hoisted(() => vi.fn());
vi.mock('$lib/forms/api', () => ({ getPublicForm }));

import { formSharePath, guestPathForMemberLink, memberFormIdOfPath } from './shareLink';

const ID = '3f2b8c1e-7a44-4d0e-9a51-0c6d2e8b9f10';

beforeEach(() => {
  getPublicForm.mockReset();
});

describe('formSharePath', () => {
  it('is the guest page for a public form and the member page otherwise', () => {
    expect(formSharePath({ id: ID, isPublic: true })).toBe(`/f/${ID}`);
    expect(formSharePath({ id: ID, isPublic: false })).toBe(`/forms/${ID}`);
    expect(formSharePath({ id: ID })).toBe(`/forms/${ID}`);
  });
});

describe('memberFormIdOfPath', () => {
  it('matches only /forms/<uuid>', () => {
    expect(memberFormIdOfPath(`/forms/${ID}`)).toBe(ID);
    expect(memberFormIdOfPath(`/forms/${ID}/`)).toBe(ID);
    expect(memberFormIdOfPath(`/forms/${ID}/edit`)).toBeNull();
    expect(memberFormIdOfPath('/forms/create')).toBeNull();
    expect(memberFormIdOfPath('/forms/success')).toBeNull();
    expect(memberFormIdOfPath(`/f/${ID}`)).toBeNull();
  });
});

describe('guestPathForMemberLink', () => {
  it('answers the guest page when the form is served as public', async () => {
    getPublicForm.mockResolvedValue({ id: ID });
    expect(await guestPathForMemberLink(`/forms/${ID}`)).toBe(`/f/${ID}`);
  });

  it('answers null when the form is not public (login, as before)', async () => {
    getPublicForm.mockRejectedValue(new Error('404'));
    expect(await guestPathForMemberLink(`/forms/${ID}`)).toBeNull();
  });

  it('asks nothing for a path that is not a member form page', async () => {
    expect(await guestPathForMemberLink('/forms/create')).toBeNull();
    expect(getPublicForm).not.toHaveBeenCalled();
  });
});
