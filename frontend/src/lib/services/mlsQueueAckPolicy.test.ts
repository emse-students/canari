import { describe, it, expect } from 'vitest';
import {
  shouldAckAfterSuccess,
  shouldAckAfterWebException,
  shouldAckAfterTauriGenericException,
  shouldAckGroupResetControl,
  isUnrecoverableError,
  isGapQueuedError,
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

  it('shouldAckAfterWebException only for commit', () => {
    expect(
      shouldAckAfterWebException({
        isWelcome: true,
        isCommit: false,
        hasQueuedId: true,
      })
    ).toBe(false);
    expect(
      shouldAckAfterWebException({
        isWelcome: false,
        isCommit: true,
        hasQueuedId: true,
      })
    ).toBe(true);
    expect(
      shouldAckAfterWebException({
        isWelcome: false,
        isCommit: false,
        hasQueuedId: true,
      })
    ).toBe(false);
  });

  it('shouldAckAfterTauriGenericException for any queued non-control message', () => {
    expect(
      shouldAckAfterTauriGenericException({
        isWelcome: false,
        isCommit: false,
        hasQueuedId: true,
      })
    ).toBe(true);
    expect(
      shouldAckAfterTauriGenericException({
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

  it('error classifiers', () => {
    expect(isUnrecoverableError('UNRECOVERABLE:foo')).toBe(true);
    expect(isGapQueuedError('GAP_QUEUED:group-1')).toBe(true);
  });
});
