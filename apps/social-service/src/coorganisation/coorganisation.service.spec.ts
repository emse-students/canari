/**
 * The co-organiser list turned into proposals (D39) - the decisions of `sync`, with no database.
 * `coorganisation.integration.spec.ts` proves the same against PostgreSQL; this one runs in CI,
 * which has none.
 */
import { ForbiddenException } from '@nestjs/common';
import type { AssociationsService } from '../associations/associations.service';
import type { PostNotificationsService } from '../posts/post-notifications.service';
import type { ProposalsService } from '../proposals/proposals.service';
import { CoorganisationService, type CoOrganiserStatus } from './coorganisation.service';

function make(states: { associationId: string; status: CoOrganiserStatus }[]) {
  const queries: string[] = [];
  const manager = {
    query: jest.fn((sql: string) => {
      queries.push(sql);
      if (sql.includes('UNION ALL')) {
        return Promise.resolve(
          states.map((s) => ({
            ...s,
            name: s.associationId,
            slug: s.associationId,
            proposalId: 'p',
          }))
        );
      }
      return Promise.resolve([]);
    }),
    transaction: jest.fn(async (fn: (m: unknown) => Promise<void>) => fn(manager)),
  };
  const proposals = {
    propose: jest.fn(() => Promise.resolve({})),
    withdrawBySubject: jest.fn(() => Promise.resolve({ id: 'p' })),
    register: jest.fn(),
  };
  const service = new CoorganisationService(
    { manager } as never,
    { registerCoOrganisers: jest.fn() } as unknown as AssociationsService,
    {} as PostNotificationsService,
    proposals as unknown as ProposalsService
  );
  return { service, proposals, queries };
}

const base = {
  eventId: 'ev-1',
  organiserId: 'org',
  actorId: 'u1',
  isGlobalAdmin: false,
  organiserSide: true,
  viaAssociationId: 'org',
};

describe('CoorganisationService.sync', () => {
  it('proposes a new name with the sender right vouched, and never the organiser itself', async () => {
    const { service, proposals } = make([]);
    await service.sync({ ...base, desiredIds: ['a3', 'org'] });
    expect(proposals.propose).toHaveBeenCalledTimes(1);
    expect(proposals.propose).toHaveBeenCalledWith('coorganise', 'ev-1', 'a3', 'u1', false, {
      senderVouched: true,
    });
  });

  it('changes nothing for an unchanged list, and never asks a refused association again', async () => {
    const { service, proposals } = make([
      { associationId: 'a1', status: 'accepted' },
      { associationId: 'a2', status: 'pending' },
      { associationId: 'a3', status: 'refused' },
    ]);
    await service.sync({ ...base, desiredIds: ['a1', 'a2', 'a3'] });
    expect(proposals.propose).not.toHaveBeenCalled();
    expect(proposals.withdrawBySubject).not.toHaveBeenCalled();
  });

  it('withdraws a pending one and ENDS an accepted one (its row deleted) when left out', async () => {
    const { service, proposals, queries } = make([
      { associationId: 'a1', status: 'accepted' },
      { associationId: 'a2', status: 'pending' },
    ]);
    await service.sync({ ...base, desiredIds: [] });
    expect(proposals.withdrawBySubject).toHaveBeenCalledWith(
      expect.anything(),
      'coorganise',
      'ev-1',
      'a2',
      'pending',
      'u1'
    );
    expect(proposals.withdrawBySubject).toHaveBeenCalledWith(
      expect.anything(),
      'coorganise',
      'ev-1',
      'a1',
      'accepted',
      'u1'
    );
    expect(
      queries.some((q) => q.startsWith('DELETE FROM association_calendar_event_co_owners'))
    ).toBe(true);
  });

  it('lets a co-organiser remove ITSELF and nothing else (403 before any write)', async () => {
    const states: { associationId: string; status: CoOrganiserStatus }[] = [
      { associationId: 'a1', status: 'accepted' },
      { associationId: 'a2', status: 'accepted' },
    ];
    const coSide = { ...base, organiserSide: false, viaAssociationId: 'a1' };

    const adding = make(states);
    await expect(
      adding.service.sync({ ...coSide, desiredIds: ['a1', 'a2', 'a9'] })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(adding.proposals.propose).not.toHaveBeenCalled();

    const removingOther = make(states);
    await expect(
      removingOther.service.sync({ ...coSide, desiredIds: ['a1'] })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(removingOther.proposals.withdrawBySubject).not.toHaveBeenCalled();

    const leaving = make(states);
    await leaving.service.sync({ ...coSide, desiredIds: ['a2'] });
    expect(leaving.proposals.withdrawBySubject).toHaveBeenCalledTimes(1);
  });
});
