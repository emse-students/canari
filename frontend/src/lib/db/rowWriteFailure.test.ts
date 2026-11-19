import { describe, expect, it } from 'vitest';
import { classifyRowWriteFailure } from './rowWriteFailure';

/**
 * A ROW THE STORE REFUSES FOR WHAT IT IS IS POISON; ANYTHING ELSE IS TRANSIENT (review of #3851).
 * Decided by the `DOMException` name - a type - and never by a message: an error whose type says
 * nothing is kept and retried, because acking past a row a retry could store costs the message.
 */
describe('classifyRowWriteFailure', () => {
  it.each(['DataError', 'DataCloneError'])(
    '%s - a key or a value the store cannot take - is poison',
    (name) => {
      expect(classifyRowWriteFailure(new DOMException('refused', name))).toBe('poison');
    }
  );

  it.each([
    'QuotaExceededError',
    'AbortError',
    'TransactionInactiveError',
    'InvalidStateError',
    'UnknownError',
  ])('%s - a failure a retry may pass - is transient', (name) => {
    expect(classifyRowWriteFailure(new DOMException('refused', name))).toBe('transient');
  });

  it('never reads a message: an untyped error or a string NAMING a poison class is transient', () => {
    expect(classifyRowWriteFailure(new Error('DataError: bad key'))).toBe('transient');
    expect(classifyRowWriteFailure('saveMessagesIfAbsent error: DataCloneError')).toBe('transient');
    expect(classifyRowWriteFailure(null)).toBe('transient');
    expect(classifyRowWriteFailure(undefined)).toBe('transient');
  });
});
