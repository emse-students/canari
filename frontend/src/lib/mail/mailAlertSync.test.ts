import { describe, expect, it, vi } from 'vitest';
import { MailAlertServerError } from './mailAlert';
import { createMailAlertSync } from './mailAlertSync';

vi.mock('$lib/utils/Log', () => ({
  Log: { d: vi.fn(), i: vi.fn(), w: vi.fn(), e: vi.fn() },
}));

const input = (
  over: Partial<{
    ready: boolean;
    pushKnown: boolean;
    want: boolean;
    leave: 'password_refused' | 'account_closed' | 'mail_off' | null;
  }> = {}
) => ({
  userId: 'u1',
  ready: true,
  pushKnown: true,
  want: true,
  ...over,
});

describe('createMailAlertSync', () => {
  it('waits for an open mailbox and a READ server switch', async () => {
    const run = vi.fn(async () => 'configured' as const);
    const sync = createMailAlertSync(run);
    sync.update(input({ ready: false }));
    sync.update(input({ pushKnown: false }));
    await sync.idle();
    expect(run).not.toHaveBeenCalled();
    sync.update(input());
    await sync.idle();
    expect(run).toHaveBeenCalledWith('u1', true);
  });

  it('runs one sync at a time and the LAST facts once it settles', async () => {
    let release!: () => void;
    const run = vi.fn(
      (_u: string, want: boolean) =>
        new Promise<'configured' | 'removed'>((resolve) => {
          release = () => resolve(want ? 'configured' : 'removed');
        })
    );
    const sync = createMailAlertSync(run);
    sync.update(input());
    sync.update(input({ want: false }));
    sync.update(input({ want: true }));
    sync.update(input({ want: false }));
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    release();
    await sync.idle();
    expect(run.mock.calls).toEqual([
      ['u1', true],
      ['u1', false],
    ]);
  });

  it('the same facts again do nothing, a closed mailbox forgets them', async () => {
    const run = vi.fn(async () => 'unchanged' as const);
    const sync = createMailAlertSync(run);
    sync.update(input());
    await sync.idle();
    sync.update(input());
    await sync.idle();
    expect(run).toHaveBeenCalledTimes(1);
    sync.update(input({ ready: false }));
    sync.update(input());
    await sync.idle();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a failed sync is retried at the next fact, never on a timer', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('configured');
    const sync = createMailAlertSync(run);
    sync.update(input());
    await sync.idle();
    sync.update(input());
    await sync.idle();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a mailbox that left ready for a leave cause takes the device out once, with no mailbox', async () => {
    const run = vi.fn(async () => 'configured' as const);
    const leave = vi.fn(async () => 'left' as const);
    const sync = createMailAlertSync(run, leave);
    sync.update(input());
    await sync.idle();
    sync.update(input({ ready: false }));
    await sync.idle();
    expect(leave).not.toHaveBeenCalled();
    sync.update(input({ ready: false, leave: 'password_refused' }));
    sync.update(input({ ready: false, leave: 'password_refused' }));
    await sync.idle();
    expect(leave).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledWith('u1', 'password_refused');
  });

  it('a sign-out quiesces it: the task in flight settles and nothing starts until the mailbox closes', async () => {
    let release!: () => void;
    const run = vi
      .fn(async () => 'configured' as const)
      .mockImplementationOnce(
        () => new Promise<'configured'>((resolve) => (release = () => resolve('configured')))
      );
    const sync = createMailAlertSync(run);
    sync.update(input());
    let quiet = false;
    const quiesced = sync.quiesce().then(() => (quiet = true));
    await Promise.resolve();
    expect(quiet).toBe(false);
    release();
    await quiesced;
    sync.update(input({ want: false }));
    await sync.idle();
    expect(run).toHaveBeenCalledTimes(1);
    // The mailbox closed (the sign-out ended it): the next opening syncs again.
    sync.update(input({ ready: false }));
    sync.update(input({ want: false }));
    await sync.idle();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a sync refused for want of a push registration runs once more when it completes', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new MailAlertServerError('not_registered', 409))
      .mockResolvedValue('configured');
    const sync = createMailAlertSync(run);
    sync.update(input());
    await sync.idle();
    expect(run).toHaveBeenCalledTimes(1);
    sync.retryAfterPushRegistration();
    await sync.idle();
    expect(run).toHaveBeenCalledTimes(2);
    sync.retryAfterPushRegistration();
    await sync.idle();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
