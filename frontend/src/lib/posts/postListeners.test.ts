import { describe, expect, it, vi } from 'vitest';
import { PostListeners } from './postListeners';

describe('PostListeners', () => {
  it('calls only the listeners of the post published, with its arguments', () => {
    const channel = new PostListeners<[n: number, s: string]>('test', 'things');
    const onA = vi.fn();
    const onB = vi.fn();
    channel.on('a', onA);
    channel.on('b', onB);
    channel.publish('a', 1, 'x');
    expect(onA).toHaveBeenCalledWith(1, 'x');
    expect(onB).not.toHaveBeenCalled();
  });

  it('a listener that throws is logged and does not stop the others', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const channel = new PostListeners<[n: number]>('test', 'things');
    const after = vi.fn();
    channel.on('a', () => {
      throw new Error('boom');
    });
    channel.on('a', after);
    channel.publish('a', 1);
    expect(after).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(
      '[test] a listener failed to take the things of a',
      expect.any(Error)
    );
    error.mockRestore();
  });

  it('an unsubscribed listener is no longer called, and unsubscribing twice is harmless', () => {
    const channel = new PostListeners<[n: number]>('test', 'things');
    const listener = vi.fn();
    const off = channel.on('a', listener);
    off();
    off();
    channel.publish('a', 1);
    expect(listener).not.toHaveBeenCalled();
  });
});
