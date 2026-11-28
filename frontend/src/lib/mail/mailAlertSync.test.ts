import { describe, expect, it, vi } from 'vitest';
import { createMailAlertSync } from './mailAlertSync';

vi.mock('$lib/utils/Log', () => ({
  Log: { d: vi.fn(), i: vi.fn(), w: vi.fn(), e: vi.fn() },
}));

const input = (over: Partial<{ ready: boolean; pushKnown: boolean; want: boolean }> = {}) => ({
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
        new Promise<'configured' | 'restored'>((resolve) => {
          release = () => resolve(want ? 'configured' : 'restored');
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
});
