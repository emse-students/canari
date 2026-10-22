import { describe, expect, it, vi } from 'vitest';
import { deviceIdOfLeaf, userIdOfLeaf } from './leafIdentity';

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
