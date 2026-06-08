import { describe, it, expect } from 'vitest';
import {
  shouldAckAfterSuccess,
  shouldAckAfterException,
  shouldAckGroupResetControl,
} from './mlsQueueAckPolicy';

describe('mlsQueueAckPolicy', () => {
  it('shouldAckAfterSuccess respects callback retry', () => {
    expect(
      shouldAckAfterSuccess(false, {
        isWelcome: false,
        isCommit: false,
        hasQueuedId: true,
      })
    ).toBe(false);
    expect(
      shouldAckAfterSuccess(undefined, {
        isWelcome: true,
        isCommit: false,
        hasQueuedId: true,
      })
    ).toBe(true);
  });

  it('shouldAckAfterSuccess requires hasQueuedId', () => {
    expect(
      shouldAckAfterSuccess(true, {
        isWelcome: false,
        isCommit: true,
        hasQueuedId: false,
      })
    ).toBe(false);
  });

  it('shouldAckAfterSuccess is true for explicit true callback result with queued id', () => {
    expect(
      shouldAckAfterSuccess(true, {
        isWelcome: false,
        isCommit: true,
        hasQueuedId: true,
      })
    ).toBe(true);
  });

  it('shouldAckAfterException only ACKs commits (both platforms)', () => {
    // Welcome on exception → never ACK (retry on reconnect)
    expect(
      shouldAckAfterException({
        isWelcome: true,
        isCommit: false,
        hasQueuedId: true,
      })
    ).toBe(false);

    // Commit on exception → ACK (idempotent)
    expect(
      shouldAckAfterException({
        isWelcome: false,
        isCommit: true,
        hasQueuedId: true,
      })
    ).toBe(true);

    // Application message on exception → do NOT ACK (retry later)
    expect(
      shouldAckAfterException({
        isWelcome: false,
        isCommit: false,
        hasQueuedId: true,
      })
    ).toBe(false);

    // No queued id → cannot ACK regardless
    expect(
      shouldAckAfterException({
        isWelcome: false,
        isCommit: true,
        hasQueuedId: false,
      })
    ).toBe(false);
  });

  it('shouldAckGroupResetControl', () => {
    expect(shouldAckGroupResetControl({ hasQueuedId: true })).toBe(true);
    expect(shouldAckGroupResetControl({ hasQueuedId: false })).toBe(false);
  });
});
