/**
 * Behavioral contracts for docs/MLS_RECOVERY_LADDER.md — keep in sync when changing queue recovery.
 */
import { describe, it, expect } from 'vitest';
import {
  shouldAckAfterSuccess,
  shouldAckAfterWebException,
  shouldAckAfterTauriGenericException,
  shouldAckGroupResetControl,
  isUnrecoverableError,
  isGapQueuedError,
} from './mlsQueueAckPolicy';

const q = { hasQueuedId: true as const };

describe('recovery ladder: queue + Welcome/Commit policy', () => {
  it('step 1 — no ACK without persisted queue id (live-only delivery)', () => {
    expect(
      shouldAckAfterSuccess(true, { isWelcome: false, isCommit: false, hasQueuedId: false })
    ).toBe(false);
  });

  it('step 1 — callback retry (false) never ACKs', () => {
    expect(shouldAckAfterSuccess(false, { isWelcome: true, isCommit: false, ...q })).toBe(false);
    expect(shouldAckAfterSuccess(false, { isWelcome: false, isCommit: true, ...q })).toBe(false);
  });

  it('step 2 — Web: Welcome exception does not ACK; commit exception does', () => {
    expect(shouldAckAfterWebException({ isWelcome: true, isCommit: false, ...q })).toBe(false);
    expect(shouldAckAfterWebException({ isWelcome: false, isCommit: true, ...q })).toBe(true);
    expect(shouldAckAfterWebException({ isWelcome: false, isCommit: false, ...q })).toBe(false);
  });

  it('step 2 — Tauri generic branch ACKs queued id (Welcome errors handled separately in service)', () => {
    expect(shouldAckAfterTauriGenericException({ isWelcome: false, isCommit: true, ...q })).toBe(
      true
    );
    expect(shouldAckAfterTauriGenericException({ ...q, isWelcome: false, isCommit: false })).toBe(
      true
    );
    expect(shouldAckAfterTauriGenericException({ ...q, isWelcome: true, isCommit: false })).toBe(
      true
    );
  });

  it('step 2 — persisted group_reset control rows ACK when id present', () => {
    expect(shouldAckGroupResetControl({ hasQueuedId: true })).toBe(true);
    expect(shouldAckGroupResetControl({ hasQueuedId: false })).toBe(false);
  });

  it('Tauri service classifiers for non-ACK paths', () => {
    expect(isUnrecoverableError('x UNRECOVERABLE: gap')).toBe(true);
    expect(isUnrecoverableError('other')).toBe(false);
    expect(isGapQueuedError('GAP_QUEUED:g1')).toBe(true);
    expect(isGapQueuedError('ok')).toBe(false);
  });
});
