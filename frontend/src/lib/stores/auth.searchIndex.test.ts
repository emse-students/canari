// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openIndex, registerIndex, type DiscardableIndex } from '$lib/search/localIndexRegistry';

/**
 * EVERY sign-out drops the universal search's decrypted message index (owner, 2026-11-26; charter
 * principle 1): the account signed in next must never search the messages of the one that left.
 */
const { clearAuth, clearAuthLocally } = await import('$lib/stores/auth');

function heldIndex(): DiscardableIndex & { discarded: boolean } {
  const index = {
    discarded: false,
    size: 3,
    get isDiscarded() {
      return index.discarded;
    },
    discard() {
      index.discarded = true;
    },
  };
  return index;
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 }))
  );
});

describe('a sign-out drops the local message index', () => {
  it('clearAuth discards it', async () => {
    const index = heldIndex();
    registerIndex(index, 'u-1');
    await clearAuth('chosen');
    expect(index.discarded).toBe(true);
    expect(openIndex('u-1')).toBeNull();
  });

  it('clearAuthLocally discards it too', async () => {
    const index = heldIndex();
    registerIndex(index, 'u-1');
    await clearAuthLocally();
    expect(index.discarded).toBe(true);
  });
});
