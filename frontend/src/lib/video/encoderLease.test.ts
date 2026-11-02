/**
 * ONE VIDEO ENCODE AT A TIME (reels-in-chat 15.2, RC-13): the publish step and the outbox's take
 * preparation share one lease - first come, first served, released however the encode ends, and a
 * waiter whose signal aborts leaves the line holding nothing. No clock: every step is an event.
 */
import {
  EncoderLeaseAbortedError,
  acquireEncoderLease,
  encoderLeaseHolder,
  withEncoderLease,
} from './encoderLease';

describe('the encoder lease', () => {
  afterEach(() => expect(encoderLeaseHolder()).toBeNull());

  it('hands the encoder on in the order it was asked for', async () => {
    const order: string[] = [];
    const releaseFirst = await acquireEncoderLease('publish');
    const second = acquireEncoderLease('take a').then((release) => {
      order.push('take a');
      return release;
    });
    const third = acquireEncoderLease('take b').then((release) => {
      order.push('take b');
      return release;
    });
    expect(encoderLeaseHolder()).toBe('publish');
    releaseFirst();
    releaseFirst(); // a second release is a no-op, never a second hand-on
    (await second)();
    (await third)();
    expect(order).toEqual(['take a', 'take b']);
  });

  it('a waiter whose signal aborts leaves the line and the next one gets the encoder', async () => {
    const release = await acquireEncoderLease('publish');
    const control = new AbortController();
    const abandoned = acquireEncoderLease('take a', control.signal);
    const next = acquireEncoderLease('take b');
    control.abort('cancel');
    await expect(abandoned).rejects.toBeInstanceOf(EncoderLeaseAbortedError);
    release();
    (await next)();
  });

  it('is released when the encode throws', async () => {
    await expect(
      withEncoderLease('publish', undefined, async () => {
        throw new Error('encoder refused');
      })
    ).rejects.toThrow('encoder refused');
    expect(await withEncoderLease('take', undefined, async () => 'encoded')).toBe('encoded');
  });

  it('an already aborted signal is refused before it queues', async () => {
    const control = new AbortController();
    control.abort('cancel');
    await expect(acquireEncoderLease('take', control.signal)).rejects.toBeInstanceOf(
      EncoderLeaseAbortedError
    );
  });
});
