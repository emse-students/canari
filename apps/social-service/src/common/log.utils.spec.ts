import { describeError } from './log.utils';

describe('describeError', () => {
  it('names an error and its message, on ONE line', () => {
    expect(describeError(new TypeError('redis.incr is not a function'))).toBe(
      'TypeError: redis.incr is not a function'
    );
  });

  it('reads a DOMException-shaped error that is not an Error in this realm', () => {
    expect(describeError({ name: 'TimeoutError', message: 'The operation timed out.' })).toBe(
      'TimeoutError: The operation timed out.'
    );
  });

  it('prints anything else as text, without a control character', () => {
    expect(describeError('boom\nsecond line')).toBe('boom second line');
    expect(describeError(undefined)).toBe('undefined');
  });
});
