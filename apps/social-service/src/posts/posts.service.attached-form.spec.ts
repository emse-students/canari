import { Repository } from 'typeorm';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { RedisService } from '../common/redis/redis.service';
import { FollowsService } from '../follows/follows.service';
import { AssociationsService } from '../associations/associations.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostMediaRetentionService } from './post-media-retention.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { FORM_NOT_OF_ENTITY } from '../forms/form-ownership';
import { FORM_NOT_ON_ANONYMOUS_POST, POST_FORMS_RETIRED } from './attached-form';

/**
 * A POST PRESENTS ITS OWN ENTITY'S FORM (2026-11-14), as an agenda event already did: an
 * association's, institution's or list's post attaches only its association's forms, a personal
 * post only a form its author manages (what the composer offers a person), an anonymous post none.
 * Judged at create and at an edit that CHANGES the form; a form the post already carries is never
 * judged again. The retired inline `forms` list is refused.
 *
 * The write is replaced by a sentinel: a call that reaches it passed every check before it.
 */
describe('PostsService - the form a post attaches', () => {
  const A = '00000000-0000-4000-8000-0000000000a1';
  const B = '00000000-0000-4000-8000-0000000000b2';
  const OFFICER = 'officer';
  const PERSON = 'person';
  const OTHER = 'other';
  const FORM_OF_A = '00000000-0000-4000-8000-00000000f0a1';
  const FORM_OF_B = '00000000-0000-4000-8000-00000000f0b2';
  const PERSONAL_OF_PERSON = '00000000-0000-4000-8000-00000000f0c3';
  const PERSONAL_OF_OTHER = '00000000-0000-4000-8000-00000000f0d4';
  const FORMS: Record<string, { id: string; associationId: string | null; ownerId: string }> = {
    [FORM_OF_A]: { id: FORM_OF_A, associationId: A, ownerId: OFFICER },
    [FORM_OF_B]: { id: FORM_OF_B, associationId: B, ownerId: OTHER },
    [PERSONAL_OF_PERSON]: { id: PERSONAL_OF_PERSON, associationId: null, ownerId: PERSON },
    [PERSONAL_OF_OTHER]: { id: PERSONAL_OF_OTHER, associationId: null, ownerId: OTHER },
  };
  const REACHED_WRITE = 'reached the write';

  function makeService(opts: { managesFormsOf?: string[]; stored?: Partial<Post> } = {}) {
    const write = () => {
      throw new Error(REACHED_WRITE);
    };
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT type FROM associations')) return [{ type: 'association' }];
        if (sql.includes('SELECT status FROM forms')) return [{ status: 'published' }];
        return [];
      }),
      getRepository: () => ({
        findOne: async ({ where }: { where: { id: string } }) =>
          FORMS[where.id] ? { ...FORMS[where.id], status: 'published' } : null,
      }),
      transaction: write,
    };
    const postRepo = {
      manager,
      create: write,
      save: write,
      findOne: async () => (opts.stored ? { ...opts.stored } : null),
    };
    const mayAct = jest.fn(
      async (userId: string, associationId: string, flag: AssociationPermissionFlag) =>
        flag === AssociationPermissionFlag.POST_AS_ASSO
          ? userId === OFFICER
          : flag === AssociationPermissionFlag.MANAGE_FORMS &&
            (opts.managesFormsOf ?? []).includes(`${userId}:${associationId}`)
    );
    const service = new PostsService(
      postRepo as unknown as Repository<Post>,
      { get: jest.fn(), setex: jest.fn(), del: jest.fn() } as unknown as RedisService,
      {} as FollowsService,
      { mayAct } as unknown as AssociationsService,
      { resolveMentionedUserIds: () => [] } as unknown as PostNotificationsService,
      { assertOwnMedia: jest.fn(async () => undefined) } as unknown as PostMediaRetentionService
    );
    return { service, mayAct };
  }

  /** The typed code of a refusal, the sentinel when the write was reached. */
  async function outcome(p: Promise<unknown>): Promise<string | undefined> {
    try {
      await p;
    } catch (e: any) {
      if (e?.message === REACHED_WRITE) return REACHED_WRITE;
      return e?.response?.code ?? e?.response?.message ?? e?.message;
    }
    return 'resolved';
  }

  const create = (svc: PostsService, data: Record<string, unknown>, isGlobalAdmin = false) =>
    outcome(svc.createPost({ markdown: 'x', ...data }, isGlobalAdmin));

  it("an association's post attaches its own association's form, and no other", async () => {
    const { service } = makeService();
    const asA = { authorId: OFFICER, associationId: A };
    expect(await create(service, { ...asA, attachedFormId: FORM_OF_A })).toBe(REACHED_WRITE);
    expect(await create(service, { ...asA, attachedFormId: FORM_OF_B })).toBe(FORM_NOT_OF_ENTITY);
    expect(await create(service, { ...asA, attachedFormId: PERSONAL_OF_OTHER })).toBe(
      FORM_NOT_OF_ENTITY
    );
    // Managing B's forms changes nothing: A's post presents A's forms (the agenda event's rule).
    const both = makeService({ managesFormsOf: [`${OFFICER}:${B}`] });
    expect(await create(both.service, { ...asA, attachedFormId: FORM_OF_B })).toBe(
      FORM_NOT_OF_ENTITY
    );
  });

  it('a personal post attaches a form its author manages, never anyone else', async () => {
    const { service } = makeService({ managesFormsOf: [`${PERSON}:${B}`] });
    const asPerson = { authorId: PERSON };
    expect(await create(service, { ...asPerson, attachedFormId: PERSONAL_OF_PERSON })).toBe(
      REACHED_WRITE
    );
    expect(await create(service, { ...asPerson, attachedFormId: FORM_OF_B })).toBe(REACHED_WRITE);
    expect(await create(service, { ...asPerson, attachedFormId: PERSONAL_OF_OTHER })).toBe(
      FORM_NOT_OF_ENTITY
    );
    expect(await create(service, { ...asPerson, attachedFormId: FORM_OF_A })).toBe(
      FORM_NOT_OF_ENTITY
    );
  });

  it('refuses the retired inline forms list, typed, and still answers an unknown form', async () => {
    const { service } = makeService();
    const asA = { authorId: OFFICER, associationId: A };
    expect(await create(service, { ...asA, forms: [{ id: FORM_OF_A, title: 'Gala' }] })).toBe(
      POST_FORMS_RETIRED
    );
    expect(await create(service, { ...asA, forms: [{ title: 'Gala' }] })).toBe(POST_FORMS_RETIRED);
    // An empty list names nothing: what an older body may carry by default.
    expect(await create(service, { ...asA, forms: [], attachedFormId: FORM_OF_A })).toBe(
      REACHED_WRITE
    );
    expect(
      await create(service, { ...asA, attachedFormId: '00000000-0000-4000-8000-000000000000' })
    ).toBe('Linked form not found');
  });

  it('an anonymous post carries no form, even one its author manages', async () => {
    const { service } = makeService();
    const anon = { authorId: PERSON, anonymous: true };
    expect(await create(service, { ...anon, attachedFormId: PERSONAL_OF_PERSON })).toBe(
      FORM_NOT_ON_ANONYMOUS_POST
    );
    expect(await create(service, anon)).toBe(REACHED_WRITE);
  });

  describe('an edit', () => {
    const stored = (over: Partial<Post>) =>
      ({
        id: 'p1',
        kind: 'post',
        authorId: OFFICER,
        associationId: A,
        attachedFormId: null,
        studentsOnly: false,
        ...over,
      }) as unknown as Partial<Post>;

    it('judges a form it CHANGES to, by the same rule', async () => {
      const { service } = makeService({ stored: stored({}) });
      expect(
        await outcome(
          service.updatePost('p1', OFFICER, { markdown: 'x', attachedFormId: FORM_OF_B })
        )
      ).toBe(FORM_NOT_OF_ENTITY);
      expect(
        await outcome(
          service.updatePost('p1', OFFICER, { markdown: 'x', attachedFormId: FORM_OF_A })
        )
      ).toBe(REACHED_WRITE);
    });

    it('never judges again the form the post already carries', async () => {
      // A post written before the rule, carrying another association's form: its edit is not refused.
      const { service } = makeService({ stored: stored({ attachedFormId: FORM_OF_B }) });
      expect(
        await outcome(
          service.updatePost('p1', OFFICER, { markdown: 'x', attachedFormId: FORM_OF_B })
        )
      ).toBe(REACHED_WRITE);
    });

    it('refuses attaching a form to an anonymous post, and lets one stored before be removed', async () => {
      const anonymous = stored({
        authorId: PERSON,
        associationId: null as unknown as string,
        anonymous: true,
      });
      const { service } = makeService({ stored: anonymous });
      expect(
        await outcome(
          service.updatePost('p1', PERSON, { markdown: 'x', attachedFormId: PERSONAL_OF_PERSON })
        )
      ).toBe(FORM_NOT_ON_ANONYMOUS_POST);
      const carrying = makeService({
        stored: { ...anonymous, attachedFormId: PERSONAL_OF_PERSON } as Partial<Post>,
      });
      expect(
        await outcome(
          carrying.service.updatePost('p1', PERSON, { markdown: 'x', attachedFormId: null })
        )
      ).toBe(REACHED_WRITE);
    });

    it("judges a personal post's form for its author, whoever edits", async () => {
      const { service } = makeService({
        stored: stored({ authorId: PERSON, associationId: null as unknown as string }),
      });
      expect(
        await outcome(
          service.updatePost('p1', PERSON, { markdown: 'x', attachedFormId: PERSONAL_OF_OTHER })
        )
      ).toBe(FORM_NOT_OF_ENTITY);
      expect(
        await outcome(
          service.updatePost('p1', PERSON, { markdown: 'x', attachedFormId: PERSONAL_OF_PERSON })
        )
      ).toBe(REACHED_WRITE);
    });
  });
});
