// @vitest-environment happy-dom
/**
 * Before the WASM client exists, `getLocalGroups()` answers `[]` - a list that says nothing about
 * what is held, so `heldGroupsKnown()` must not vouch for it: a decision taken on a group's absence
 * (a record dropped as "no longer held") would be taken on an empty cache.
 */
vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));

import { WebMlsService } from './WebMlsService';

describe('WebMlsService - whether the held-groups list is known', () => {
  it('is not known before the client exists, and is once it does', () => {
    const svc = new WebMlsService();
    expect(svc.getLocalGroups()).toEqual([]);
    expect(svc.heldGroupsKnown()).toBe(false);

    (svc as unknown as { client: { get_groups: () => string[] } }).client = {
      get_groups: () => ['g1'],
    };
    expect(svc.heldGroupsKnown()).toBe(true);
    expect(svc.getLocalGroups()).toEqual(['g1']);
  });
});
