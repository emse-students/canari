// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PENDING_CONTACT_KEY,
  rememberSelectionForReload,
  setSelectionProvider,
} from './selectionAcrossReload';

describe('rememberSelectionForReload', () => {
  beforeEach(() => {
    sessionStorage.clear();
    setSelectionProvider(() => '');
  });

  it('writes the open conversation where MainChatPage reads it after the load', () => {
    setSelectionProvider(() => 'conv-1');
    const log = vi.fn();
    rememberSelectionForReload(log);
    expect(sessionStorage.getItem(PENDING_CONTACT_KEY)).toBe('conv-1');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when no conversation is open', () => {
    rememberSelectionForReload(vi.fn());
    expect(sessionStorage.getItem(PENDING_CONTACT_KEY)).toBeNull();
  });

  it('logs and survives a provider that throws', () => {
    setSelectionProvider(() => {
      throw new Error('boom');
    });
    const log = vi.fn();
    expect(() => rememberSelectionForReload(log)).not.toThrow();
    expect(log.mock.calls[0][0]).toContain('boom');
  });
});
