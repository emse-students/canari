/**
 * The dashboard place carries the admin queues' pending sum (owner, 2026-11-18): the bottom bar's
 * way to the Administration row. Not on the place the reader is on, not signed out, and never for a
 * member, whose counts are empty.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const session = vi.hoisted(() => ({ isLoggedIn: true }));
const admin = vi.hoisted(() => ({ total: 0 }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: session,
  globalConvs: { conversations: new Map() },
}));
vi.mock('$lib/stores/postNotifStore.svelte', () => ({ postNotifStore: { unread: 0 } }));
vi.mock('$lib/admin/adminQueueCounts.svelte', () => ({ adminQueueCounts: admin }));
vi.mock('$lib/utils/chat/channelCrypto', () => ({ isChannelConversationId: () => false }));

import { placeBadge } from './placeBadge.svelte';

describe('placeBadge: the dashboard', () => {
  beforeEach(() => {
    session.isLoggedIn = true;
    admin.total = 0;
  });

  it('carries the admin pending sum', () => {
    admin.total = 3;
    expect(placeBadge('dashboard', false)).toBe(3);
  });

  it('carries nothing on the dashboard itself, signed out, or when nothing waits', () => {
    admin.total = 3;
    expect(placeBadge('dashboard', true)).toBe(0);
    session.isLoggedIn = false;
    expect(placeBadge('dashboard', false)).toBe(0);
    session.isLoggedIn = true;
    admin.total = 0;
    expect(placeBadge('dashboard', false)).toBe(0);
  });
});
