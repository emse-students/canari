vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));

import { WebMlsService } from './WebMlsService';
import { FollowerTabCommitError } from '$lib/mls-client/commitSubmission';

/**
 * A GROUP CREATED IN A FOLLOWER TAB EXISTS ONLY IN THAT TAB'S COPY of the state: the leader never
 * holds it, and the version guard refuses the copy's writes. So creation is refused at the
 * service's own entry (`BaseMlsService.createGroup`), before the platform is asked for anything -
 * every caller inherits it. Driven through the real web service, so the platform call is the one
 * production makes.
 */
describe('BaseMlsService.createGroup', () => {
  function service() {
    const svc = Object.create(WebMlsService.prototype) as WebMlsService;
    const client = { create_group: vi.fn() };
    Object.assign(svc, { client });
    return { svc, client };
  }

  afterEach(() => vi.restoreAllMocks());

  it('refuses on a follower tab, before the platform creates anything', async () => {
    const leadership = await import('$lib/mls-client/tabLeader');
    vi.spyOn(leadership, 'getTabLeadership').mockReturnValue('follower');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { svc, client } = service();

    await expect(svc.createGroup('g-1')).rejects.toBeInstanceOf(FollowerTabCommitError);
    expect(client.create_group).not.toHaveBeenCalled();
  });

  it.each(['leader', 'undecided'] as const)('creates on a %s tab', async (state) => {
    const leadership = await import('$lib/mls-client/tabLeader');
    vi.spyOn(leadership, 'getTabLeadership').mockReturnValue(state);
    const { svc, client } = service();

    await svc.createGroup('g-1');
    expect(client.create_group).toHaveBeenCalledExactlyOnceWith('g-1');
  });
});
