import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AssociationsService } from '../associations/associations.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { Proposal } from './proposal.entity';
import { ProposalsService, type ProposalKindHandler } from './proposals.service';

/**
 * THE GENERIC STATE MACHINE, against fakes: what it refuses and in which order. The writes
 * themselves - the unique index, the conditional update, the transaction around `apply` - are
 * PostgreSQL's and proven in `posts/republications.integration.spec.ts`.
 */
describe('ProposalsService', () => {
  const FROM = 'asso-from';
  const TO = 'asso-to';

  function makeService(opts: { mayAct?: boolean; saveError?: unknown; pending?: boolean } = {}) {
    const query = jest.fn((sql: string) => {
      if (sql.startsWith('UPDATE proposals')) {
        return Promise.resolve(
          opts.pending === false ? [[], 0] : [[{ id: 'x1', kind: 'repost' }], 1]
        );
      }
      if (sql.includes('FROM association_members')) return Promise.resolve([{ userId: 'u1' }]);
      return Promise.resolve([]);
    });
    const manager = { query, transaction: jest.fn((fn: (m: unknown) => unknown) => fn(manager)) };
    const repo = {
      create: jest.fn((row: Partial<Proposal>) => row),
      save: jest.fn((row: Partial<Proposal>) =>
        opts.saveError ? Promise.reject(opts.saveError) : Promise.resolve({ id: 'x1', ...row })
      ),
      findOne: jest.fn(() =>
        Promise.resolve({
          id: 'x1',
          kind: 'repost',
          fromAssociationId: FROM,
          toAssociationId: TO,
          status: 'pending',
        })
      ),
      manager,
    };
    const associations = { mayAct: jest.fn(() => Promise.resolve(opts.mayAct ?? true)) };
    const apply = jest.fn(() => Promise.resolve(() => Promise.resolve()));
    const announce = jest.fn((_proposal: unknown, _acceptors: string[]) => Promise.resolve());
    const transaction = manager.transaction;
    const mayAct = associations.mayAct;
    const save = repo.save;
    const handler: ProposalKindHandler = {
      kind: 'repost',
      senderFlag: AssociationPermissionFlag.POST_AS_ASSO,
      acceptorFlag: AssociationPermissionFlag.POST_AS_ASSO,
      resolveSender: jest.fn(() => Promise.resolve(FROM)),
      apply,
      announce,
      describe: jest.fn(() => Promise.resolve(new Map())),
    };
    const service = new ProposalsService(
      repo as unknown as Repository<Proposal>,
      associations as unknown as AssociationsService
    );
    service.register(handler);
    return { service, handler, apply, announce, transaction, mayAct, save };
  }

  it('refuses a kind registered twice - a wiring defect, not a runtime choice', () => {
    const { service, handler } = makeService();
    expect(() => service.register(handler)).toThrow('registered twice');
  });

  it('refuses an unknown kind with a 400', async () => {
    const { service } = makeService();
    await expect(
      service.propose('coorganise' as never, 's1', TO, 'u1', false)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('asks the sender flag in the SENDING association, and stores nothing without it', async () => {
    const { service, mayAct, save } = makeService({ mayAct: false });
    await expect(service.propose('repost', 's1', TO, 'u1', false)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(mayAct).toHaveBeenCalledWith('u1', FROM, AssociationPermissionFlag.POST_AS_ASSO, {
      isGlobalAdmin: false,
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('answers a duplicate (the unique index, read by its SQLSTATE) with a 409', async () => {
    const { service, announce } = makeService({ saveError: { code: '23505' } });
    await expect(service.propose('repost', 's1', TO, 'u1', false)).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(announce).not.toHaveBeenCalled();
  });

  it('announces a stored proposal to the receiving holders', async () => {
    const { service, announce } = makeService();
    await service.propose('repost', 's1', TO, 'u1', false);
    expect(announce).toHaveBeenCalledWith(expect.objectContaining({ id: 'x1' }), ['u1']);
  });

  it('keeps a stored proposal when its announcement fails, and says so', async () => {
    const { service, announce } = makeService();
    announce.mockRejectedValueOnce(new Error('push down'));
    await expect(service.propose('repost', 's1', TO, 'u1', false)).resolves.toMatchObject({
      id: 'x1',
    });
  });

  it('accepts by applying the kind INSIDE the decision transaction', async () => {
    const { service, apply, transaction } = makeService();
    await service.accept('x1', 'u1', false);
    expect(transaction).toHaveBeenCalled();
    expect(apply).toHaveBeenCalled();
  });

  it('answers a decision on a proposal no longer pending with a 409, and applies nothing', async () => {
    const { service, apply } = makeService({ pending: false });
    await expect(service.accept('x1', 'u1', false)).rejects.toBeInstanceOf(ConflictException);
    expect(apply).not.toHaveBeenCalled();
    await expect(service.refuse('x1', 'u1', false)).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a queue to whoever holds neither flag there', async () => {
    const { service } = makeService({ mayAct: false });
    await expect(service.listPending(TO, 'u1', false)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
