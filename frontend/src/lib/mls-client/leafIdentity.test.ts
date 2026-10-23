import { describe, expect, it, vi } from 'vitest';
import {
  canonicalIdentity,
  canonicalUserId,
  canonicalUserOf,
  deviceIdOfLeaf,
  sameDeviceIdentity,
  treeHoldsDevice,
  treeHoldsUser,
  userIdOfLeaf,
} from './leafIdentity';

describe('leafIdentity - one colon at most, as Rust binds it', () => {
  it('splits a well-formed identity, the user half lower-cased', () => {
    expect(userIdOfLeaf('Bob:web-1')).toBe('bob');
    expect(deviceIdOfLeaf('Bob:web-1')).toBe('web-1');
  });

  it('keeps reading a bare user id as a user with no device', () => {
    expect(userIdOfLeaf('bob')).toBe('bob');
    expect(deviceIdOfLeaf('bob')).toBe('');
  });

  it('refuses an identity with more than one colon: both halves name nobody, said once', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(userIdOfLeaf('bob:web-1:extra')).toBe('');
    expect(deviceIdOfLeaf('bob:web-1:extra')).toBe('');
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

// THE SAME CANONICAL IDENTITY AS RUST (`device_trust::canonical_identity`): the user half
// ASCII-lowercased, the device half exact, one colon and two non-empty halves - the cases of
// `the_user_half_ignores_case_and_the_device_half_does_not`, so the two sides cannot drift.
describe('leafIdentity - the one canonical identity, as Rust keys the pins', () => {
  it('reads the user half without case and the device half exactly', () => {
    expect(canonicalIdentity('ABC:web-1')).toBe('abc:web-1');
    expect(sameDeviceIdentity('ABC:web-1', 'abc:web-1')).toBe(true);
    expect(sameDeviceIdentity('abc:WEB-1', 'abc:web-1')).toBe(false);
    expect(sameDeviceIdentity('abc:web-1', 'abd:web-1')).toBe(false);
  });

  it('names nobody for anything but one colon between two non-empty halves', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const bad of ['abc:web-1:x', 'abc', ':web-1', 'abc:']) {
      expect(canonicalIdentity(bad)).toBeNull();
      expect(sameDeviceIdentity(bad, bad)).toBe(false);
    }
    error.mockRestore();
  });

  it('lowers ASCII only, as Rust does', () => {
    expect(canonicalUserId('ÉRIC')).toBe('Éric');
  });

  it('finds a device in a tree under any spelling of its user', () => {
    expect(treeHoldsDevice(['me:self', 'Legit-User:dev-1'], 'legit-user', 'dev-1')).toBe(true);
    expect(treeHoldsDevice(['legit-user:DEV-1'], 'legit-user', 'dev-1')).toBe(false);
  });
});

// THE LEGACY BARE CREDENTIAL (`userId`, no device), as Rust's `canonical_user_of` reads it - the
// cases of `a_bare_identity_names_its_user_and_no_device` (tests/legacy_bare_leaf.rs).
describe('leafIdentity - a legacy bare leaf names its user and no device', () => {
  it('names the user of a bare leaf, and never matches a device', () => {
    expect(canonicalUserOf('BoB')).toBe('bob');
    expect(canonicalIdentity('bob')).toBeNull();
    expect(sameDeviceIdentity('bob', 'bob:dev1')).toBe(false);
    expect(treeHoldsDevice(['bob'], 'bob', 'dev1')).toBe(false);
  });

  it('names nobody for what Rust refuses', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const bad of ['', 'bob:', ':dev1', 'bob:a:b']) {
      expect(canonicalUserOf(bad)).toBeNull();
      expect(userIdOfLeaf(bad)).toBe('');
    }
    error.mockRestore();
  });
});

// THE QUESTION AN AUTOMATIC ADD ASKS (`actions.ts`): is this a device of a user already in the tree,
// or a new person? Read on the user half alone, canonically, so a member's new device is never taken
// for a stranger and a stranger never borrows a member's device id.
describe('leafIdentity - whether a tree holds any leaf of a user', () => {
  it('finds a user by any of their devices, under any spelling of the user half', () => {
    expect(treeHoldsUser(['me:self', 'Peer:old-phone'], 'peer')).toBe(true);
  });

  it('does not let another user with the same device id answer for them', () => {
    expect(treeHoldsUser(['me:self', 'peer:dev-1'], 'stranger')).toBe(false);
  });

  it('counts a legacy bare leaf as its user', () => {
    expect(treeHoldsUser(['me:self', 'peer'], 'peer')).toBe(true);
  });

  it('holds nobody for an empty user id or an empty tree', () => {
    expect(treeHoldsUser(['me:self'], '')).toBe(false);
    expect(treeHoldsUser([], 'peer')).toBe(false);
  });
});
