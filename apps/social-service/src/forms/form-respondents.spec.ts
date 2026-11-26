import { ConflictException, NotFoundException } from '@nestjs/common';
import { FormsService } from './forms.service';
import {
  FORM_RESPONDENTS_ANONYMOUS,
  FORM_RESPONDENTS_PUBLIC,
  respondentGroupRefusal,
  respondentIds,
} from './form-respondents';

/**
 * A GROUP MADE FROM A FORM'S RESPONDENTS (owner, 2026-11-19): the server is where an anonymous or a
 * public form is refused, so a client that draws the button anyway reads nothing.
 */
describe('form respondents - the rule', () => {
  it('refuses an anonymous form, then a public one, and nothing else', () => {
    expect(respondentGroupRefusal({ anonymous: true, isPublic: false })).toBe(
      FORM_RESPONDENTS_ANONYMOUS
    );
    expect(respondentGroupRefusal({ anonymous: true, isPublic: true })).toBe(
      FORM_RESPONDENTS_ANONYMOUS
    );
    expect(respondentGroupRefusal({ anonymous: false, isPublic: true })).toBe(
      FORM_RESPONDENTS_PUBLIC
    );
    expect(respondentGroupRefusal({ anonymous: false, isPublic: false })).toBeNull();
  });

  it('lists each account once, skipping guests and answers that were never kept', () => {
    expect(
      respondentIds([
        { userId: 'a', paymentStatus: 'free' },
        { userId: null, paymentStatus: 'paid' },
        { userId: 'b', paymentStatus: 'cancelled' },
        { userId: 'c', paymentStatus: 'expired' },
        { userId: 'a', paymentStatus: 'paid' },
        { userId: 'd', paymentStatus: 'waiting' },
      ])
    ).toEqual(['a', 'd']);
  });
});

describe('FormsService.respondentsForGroup', () => {
  function makeService(form: Record<string, unknown> | null, users: Record<string, unknown>[]) {
    const formRepo: any = { findOne: jest.fn(() => Promise.resolve(form)), manager: {} };
    const submissionRepo: any = {
      find: jest.fn(() =>
        Promise.resolve([
          { userId: 'u1', paymentStatus: 'free' },
          { userId: 'u2', paymentStatus: 'free' },
          { userId: 'gone', paymentStatus: 'free' },
        ])
      ),
      manager: { query: jest.fn(() => Promise.resolve(users)) },
    };
    const service = new FormsService(
      formRepo,
      submissionRepo,
      { findOne: jest.fn(), save: jest.fn() } as any,
      { get: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { enabled: () => false } as any,
      {} as any
    );
    return { service, submissionRepo };
  }

  it('answers 404 to a form that does not exist', async () => {
    const { service } = makeService(null, []);
    await expect(service.respondentsForGroup('f1')).rejects.toThrow(NotFoundException);
  });

  it.each([
    [{ anonymous: true, isPublic: false }, FORM_RESPONDENTS_ANONYMOUS],
    [{ anonymous: false, isPublic: true }, FORM_RESPONDENTS_PUBLIC],
  ])('refuses %j with %s and reads no answer', async (flags, code) => {
    const { service, submissionRepo } = makeService({ id: 'f1', ...flags }, []);
    const refusal = await service.respondentsForGroup('f1').catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getResponse()).toMatchObject({ code });
    expect(submissionRepo.find).not.toHaveBeenCalled();
  });

  it('lists the accounts it still holds and counts the departed ones', async () => {
    const { service } = makeService({ id: 'f1', anonymous: false, isPublic: false }, [
      { id: 'u1', firstName: 'Ada', lastName: 'L' },
      { id: 'u2', firstName: null, lastName: null },
    ]);
    await expect(service.respondentsForGroup('f1')).resolves.toEqual({
      respondents: [
        { id: 'u1', firstName: 'Ada', lastName: 'L' },
        { id: 'u2', firstName: null, lastName: null },
      ],
      departed: 1,
    });
  });
});
