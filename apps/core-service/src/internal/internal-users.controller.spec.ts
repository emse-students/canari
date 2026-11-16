import { NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { InternalUsersController } from './internal-users.controller';
import type { User } from '../users/entities/user.entity';

/**
 * THE SHARED-LINK PREVIEW NEVER NAMES A REVIEW ACCOUNT (review-cohort.ts). `/profile/<id>`'s Open
 * Graph head is rendered from this endpoint for whoever opens the link - the SSR process knows the
 * path, never the viewer - so a review account's id answers the 404 of an unknown one, read before
 * the row is, and a member's id answers as ever.
 */
describe('InternalUsersController.publicProfile and the review cohort', () => {
  const SECRET = 'internal-secret-for-tests';
  const saved = {
    secret: process.env.INTERNAL_SECRET,
    cohort: process.env.SERVICE_ACCOUNT_USER_ID,
  };
  beforeEach(() => {
    process.env.INTERNAL_SECRET = SECRET;
    process.env.SERVICE_ACCOUNT_USER_ID = 'reviewer';
  });
  afterEach(() => {
    for (const [key, value] of [
      ['INTERNAL_SECRET', saved.secret],
      ['SERVICE_ACCOUNT_USER_ID', saved.cohort],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function makeController() {
    const findOne = jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve({
        id: where.id,
        displayName: 'Name',
        promo: 2024,
        formation: 'F',
        cursus: [
          { formation: 'F', promo: 2024 },
          { formation: 'G', promo: 2025 },
        ],
      } as User)
    );
    const controller = new InternalUsersController({ findOne } as unknown as Repository<User>);
    return { controller, findOne };
  }

  it('answers 404 for a review account, in any case, and reads no row', async () => {
    const { controller, findOne } = makeController();
    for (const id of ['reviewer', 'REVIEWER']) {
      await expect(controller.publicProfile(id, SECRET)).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(findOne).not.toHaveBeenCalled();
  });

  // D32: social-service prices on EVERY cursus, so the whole list is served beside the first entry.
  it("answers a member's preview, with every cursus entry", async () => {
    const { controller } = makeController();
    await expect(controller.publicProfile('member', SECRET)).resolves.toEqual({
      id: 'member',
      displayName: 'Name',
      promo: 2024,
      formation: 'F',
      cursusViews: [
        { promo: 2024, formation: 'F' },
        { promo: 2025, formation: 'G' },
      ],
    });
  });
});

/**
 * THE ACCOUNT FIELDS A FORM JOINS TO AN ANSWER (owner, 2026-11-16) come from the account row, read
 * here, never from the respondent's request: names, campus, the posts that tell staff, and every
 * cursus through the one reconciliation pricing reads.
 */
describe('InternalUsersController.respondentIdentity', () => {
  const SECRET = 'internal-secret-for-tests';
  const saved = process.env.INTERNAL_SECRET;
  beforeEach(() => {
    process.env.INTERNAL_SECRET = SECRET;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = saved;
  });

  it('serves the names, the campus, the posts and every cursus of the account', async () => {
    const findOne = jest.fn(() =>
      Promise.resolve({
        id: 'member',
        firstName: 'Marie',
        lastName: 'CURIE',
        campus: 'gardanne',
        posts: ['EMSE'],
        promo: 2024,
        formation: 'ISMIN',
        cursus: [{ formation: 'ISMIN', promo: 2024 }],
      } as User)
    );
    const controller = new InternalUsersController({ findOne } as unknown as Repository<User>);
    await expect(controller.respondentIdentity('member', SECRET)).resolves.toEqual({
      firstName: 'Marie',
      lastName: 'CURIE',
      campus: 'gardanne',
      posts: ['EMSE'],
      cursusViews: [{ promo: 2024, formation: 'ISMIN' }],
    });
  });

  it('answers a typed 404 for an unknown account', async () => {
    const findOne = jest.fn(() => Promise.resolve(null));
    const controller = new InternalUsersController({ findOne } as unknown as Repository<User>);
    await expect(controller.respondentIdentity('nobody', SECRET)).rejects.toMatchObject({
      response: { code: 'RESPONDENT_UNKNOWN' },
    });
  });
});
