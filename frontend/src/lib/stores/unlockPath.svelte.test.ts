import {
  noteUnlockNeedsMember,
  noteUnlockUnattended,
  unlockUnattendedFor,
} from './unlockPath.svelte';

describe('unlock path', () => {
  it('starts locked, names the account its key is in hand for, and a prompt locks it again', () => {
    expect(unlockUnattendedFor()).toBeNull();
    noteUnlockUnattended('u1');
    expect(unlockUnattendedFor()).toBe('u1');
    noteUnlockNeedsMember();
    expect(unlockUnattendedFor()).toBeNull();
  });
});
