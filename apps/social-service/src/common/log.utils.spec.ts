import { describeError, errorNameOf } from './log.utils';

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

describe('describeError, in a catch', () => {
  it('never throws on a value String() cannot print', () => {
    const bare = Object.create(null);
    const hostile = {
      toString() {
        throw new Error('no text for you');
      },
    };
    expect(describeError(bare)).toBe('[object Object]');
    expect(describeError(hostile)).toBe('[object Object]');
  });

  it('includes the code when the error carries one', () => {
    expect(describeError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(
      'Error: refused [ECONNREFUSED]'
    );
    expect(describeError(Object.assign(new Error('pg'), { code: 23505 }))).toBe(
      'Error: pg [23505]'
    );
  });

  it('names every inner error of an AggregateError', () => {
    const aggregate = new AggregateError(
      [new TypeError('first'), Object.assign(new Error('second'), { code: 'E2' }), 'third'],
      'All promises were rejected'
    );
    expect(describeError(aggregate)).toBe(
      'AggregateError: All promises were rejected (TypeError: first; Error: second [E2]; third)'
    );
  });

  it('follows the cause ONE level, on one line', () => {
    const withCause = (message: string, cause: unknown) =>
      Object.assign(new Error(message), { cause });
    const inner = withCause('inner\nsecond line', new Error('too deep'));
    expect(describeError(withCause('outer', inner))).toBe(
      'Error: outer <- Error: inner second line'
    );
    expect(describeError(withCause('outer', 'plain'))).toBe('Error: outer <- plain');
  });

  it('never throws on a getter that throws, or on a Proxy whose traps throw', () => {
    const boom = () => {
      throw new Error('getter exploded');
    };
    for (const key of ['message', 'errors', 'cause', 'code']) {
      const hostile = { name: 'Error', message: 'm' };
      Object.defineProperty(hostile, key, { get: boom, enumerable: true });
      expect(() => describeError(hostile)).not.toThrow();
      expect(describeError(hostile)).toBe('[object Object]');
    }
    const proxy = new Proxy({}, { get: boom, getPrototypeOf: boom, has: boom });
    expect(() => describeError(proxy)).not.toThrow();
  });
});

describe('errorNameOf', () => {
  it('reads the name of an error-shaped value, and nothing else', () => {
    expect(errorNameOf(new DOMException('x', 'TimeoutError'))).toBe('TimeoutError');
    expect(errorNameOf('TimeoutError: text')).toBeNull();
    expect(errorNameOf(null)).toBeNull();
    expect(
      errorNameOf({
        get name(): string {
          throw new Error('no');
        },
      })
    ).toBeNull();
  });
});
