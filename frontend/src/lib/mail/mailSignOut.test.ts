import { describe, expect, it, vi } from 'vitest';
import { endMailOnSignOut, registerMailSignOut } from './mailSignOut';

/** The Canari sign-out ends the mail session through the hook the mail client registers. */

describe('endMailOnSignOut', () => {
  it('runs the registered sign-out, and nothing once unregistered', async () => {
    const signOut = vi.fn(async () => {});
    const unregister = registerMailSignOut(signOut);
    await endMailOnSignOut('signed out');
    expect(signOut).toHaveBeenCalledWith('signed out');
    unregister();
    await endMailOnSignOut('signed out');
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('never throws: the Canari sign-out goes on whatever the mailbox answers', async () => {
    const unregister = registerMailSignOut(async () => {
      throw new Error('mailbox down');
    });
    await expect(endMailOnSignOut('signed out')).resolves.toBeUndefined();
    unregister();
  });

  it("an older client's unregister does not remove a newer one", async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const unregisterFirst = registerMailSignOut(first);
    const unregisterSecond = registerMailSignOut(second);
    unregisterFirst();
    await endMailOnSignOut('switch');
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    unregisterSecond();
  });
});
