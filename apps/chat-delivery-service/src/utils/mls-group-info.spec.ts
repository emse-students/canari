import { groupInfoLeafIdentity } from './mls-group-info';
import { OPENMLS_BASE } from '../testing/openmlsExternalRemoveFixture';

describe('groupInfoLeafIdentity', () => {
  it('names every leaf of a base openmls exported, by leaf index', () => {
    expect(groupInfoLeafIdentity(OPENMLS_BASE, 0)).toBe('user-0:device-0');
    expect(groupInfoLeafIdentity(OPENMLS_BASE, 1)).toBe('user-1:device-1');
    expect(groupInfoLeafIdentity(OPENMLS_BASE, 2)).toBe('user-2:device-2');
  });

  it('answers null past the tree, and for bytes that are not a GroupInfo', () => {
    expect(groupInfoLeafIdentity(OPENMLS_BASE, 3)).toBeNull();
    expect(groupInfoLeafIdentity('cGF5bG9hZA==', 0)).toBeNull();
    const truncated = Buffer.from(OPENMLS_BASE, 'base64').subarray(0, 200).toString('base64');
    expect(groupInfoLeafIdentity(truncated, 2)).toBeNull();
  });
});
