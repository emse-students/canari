import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';
import type { WorkspaceDto, ChannelDto } from '$lib/services/ChannelService';

vi.mock('$lib/stores/auth', () => ({
  getToken: vi.fn().mockResolvedValue('test-token'),
  refresh: vi.fn().mockRejectedValue(new Error('refresh failed')),
  clearAuth: vi.fn(),
}));

vi.mock('$lib/paraglide/messages', () => ({
  m: {
    channel_action_community_load: vi.fn(() => 'Loading communities'),
    channel_action_error_session: vi.fn(
      ({ action }: { action: string }) => `${action}: session expired`
    ),
    channel_action_error_permission: vi.fn(
      ({ action, detail }: { action: string; detail: string }) =>
        `${action}: permission denied (${detail})`
    ),
    channel_action_error_network: vi.fn(
      ({ action }: { action: string }) => `${action}: network error`
    ),
    channel_action_error_generic: vi.fn(
      ({ action, detail }: { action: string; detail: string }) => `${action}: ${detail}`
    ),
    channel_action_error_conflict: vi.fn(({ action }: { action: string }) => `${action}: conflict`),
  },
}));

vi.mock('$lib/stores/toast.svelte', () => ({
  showToast: vi.fn(),
}));

vi.mock('$lib/utils/chat/channelCrypto', () => ({
  isChannelConversationId: (id: string) => id.startsWith('channel_'),
  hydrateChannelBootstrap: vi.fn().mockResolvedValue({ keyVersion: 1 }),
  sendEncryptedChannelMessage: vi.fn(),
}));

const listUserWorkspaces = vi.fn();
const listChannels = vi.fn();

vi.mock('$lib/services/ChannelService', () => ({
  ChannelService: class MockChannelService {
    listUserWorkspaces = listUserWorkspaces;
    listChannels = listChannels;
  },
}));

import { useChannelWorkspaces, type ChannelWorkspaceContext } from './useChannelWorkspaces.svelte';

function makeContext(overrides: Partial<ChannelWorkspaceContext> = {}): ChannelWorkspaceContext {
  return {
    conversations: new SvelteMap<string, any>(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    selectConversation: vi.fn(),
    getSelectedConversationId: () => null,
    reloadChannelHistory: vi.fn().mockResolvedValue(undefined),
    invalidateChannelHistoryCache: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
}

function makeWorkspaceDto(id: string, name: string, slug: string): WorkspaceDto {
  return {
    _id: id,
    id,
    name,
    slug,
    imageMediaId: null,
    viewerCanManage: false,
    viewerCanModerate: false,
  } as WorkspaceDto;
}

function makeChannelDto(
  id: string,
  name: string,
  visibility: 'public' | 'private' = 'public'
): ChannelDto {
  return {
    _id: id,
    id,
    name,
    visibility,
  } as ChannelDto;
}

function tick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('useChannelWorkspaces - loadChannelWorkspacesFromBackend', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listUserWorkspaces.mockReset();
    listChannels.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('updates channelWorkspaces and clears workspacesLoadError on success', async () => {
    listUserWorkspaces.mockResolvedValue([makeWorkspaceDto('ws1', 'Community', 'community')]);
    listChannels.mockResolvedValue([makeChannelDto('ch1', 'general')]);

    const store = useChannelWorkspaces();
    const ctx = makeContext();
    const promise = store.loadChannelWorkspacesFromBackend(ctx);
    await tick();
    await promise;

    expect(store.workspacesLoadError).toBeNull();
    expect(store.channelWorkspaces).toHaveLength(1);
    expect(store.channelWorkspaces[0].channels[0].id).toBe('channel_ch1');
  });

  it('retries on transient failure and succeeds on second attempt, preserving existing data', async () => {
    listUserWorkspaces
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce([makeWorkspaceDto('ws1', 'Community', 'community')]);
    listChannels.mockResolvedValue([makeChannelDto('ch1', 'general')]);

    const store = useChannelWorkspaces();
    const ctx = makeContext();

    // Seed existing data
    store.channelWorkspaces = [
      {
        id: 'existing',
        name: 'Existing',
        avatarUserId: 'Existing',
        channels: [{ id: 'channel_old', name: 'old' }],
      } as any,
    ];

    const promise = store.loadChannelWorkspacesFromBackend(ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    await tick();
    await promise;

    expect(store.workspacesLoadError).toBeNull();
    expect(store.channelWorkspaces).toHaveLength(1);
    expect(store.channelWorkspaces[0].id).toBe('community');
    expect(listUserWorkspaces).toHaveBeenCalledTimes(2);
  });

  it('sets workspacesLoadError and preserves channelWorkspaces after 3 retryable failures', async () => {
    listUserWorkspaces.mockRejectedValue(new TypeError('Network failure'));

    const store = useChannelWorkspaces();
    const ctx = makeContext();

    const seeded = [
      {
        id: 'seeded',
        name: 'Seeded',
        avatarUserId: 'Seeded',
        channels: [{ id: 'channel_seed', name: 'seed' }],
      } as any,
    ];
    store.channelWorkspaces = seeded;

    const promise = store.loadChannelWorkspacesFromBackend(ctx);
    await vi.advanceTimersByTimeAsync(1_000 + 3_000 + 7_000);
    await tick();
    await promise;

    expect(store.workspacesLoadError).not.toBeNull();
    expect(store.channelWorkspaces).toHaveLength(1);
    expect(store.channelWorkspaces[0].id).toBe('seeded');
    expect(listUserWorkspaces).toHaveBeenCalledTimes(4);
  });

  it('does not retry on 401/403 and sets workspacesLoadError', async () => {
    listUserWorkspaces.mockRejectedValue(
      new Error(JSON.stringify({ statusCode: 401, message: 'Unauthorized' }))
    );

    const store = useChannelWorkspaces();
    const ctx = makeContext();
    const promise = store.loadChannelWorkspacesFromBackend(ctx);
    await tick();
    await promise;

    expect(store.workspacesLoadError).not.toBeNull();
    expect(listUserWorkspaces).toHaveBeenCalledTimes(1);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('non-retryable'));
  });

  it('returns false and does not issue a second request while a load is already in flight', async () => {
    const store = useChannelWorkspaces();
    const ctx = makeContext();

    // Start a load that will never resolve, then synchronously issue a second call.
    // Because `isLoadingWorkspaces` is set before the first `await`, the second call
    // must hit the guard and return `false` without any network request.
    listUserWorkspaces.mockImplementationOnce(() => new Promise(() => {}));

    // The first load never settles, so it is deliberately left dangling.
    void store.loadChannelWorkspacesFromBackend(ctx);

    await expect(store.loadChannelWorkspacesFromBackend(ctx)).resolves.toBe(false);
    expect(listUserWorkspaces).toHaveBeenCalledTimes(1);
  });
});

describe('useChannelWorkspaces - online/foreground refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listUserWorkspaces.mockReset();
    listChannels.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('reloads workspaces when load error exists and refresh is triggered externally', async () => {
    listUserWorkspaces
      .mockRejectedValueOnce(new TypeError('Offline'))
      .mockRejectedValueOnce(new TypeError('Offline'))
      .mockRejectedValueOnce(new TypeError('Offline'))
      .mockRejectedValueOnce(new TypeError('Offline'))
      .mockResolvedValueOnce([makeWorkspaceDto('ws1', 'Community', 'community')]);
    listChannels.mockResolvedValue([makeChannelDto('ch1', 'general')]);

    const store = useChannelWorkspaces();
    const ctx = makeContext();

    // First load fails and exhausts retries
    const first = store.loadChannelWorkspacesFromBackend(ctx);
    await vi.advanceTimersByTimeAsync(1_000 + 3_000 + 7_000);
    await tick();
    await first;
    expect(store.workspacesLoadError).not.toBeNull();

    // Simulate online/foreground handler: re-invoke when an error is present
    const retry = store.loadChannelWorkspacesFromBackend(ctx);
    await tick();
    await retry;

    expect(store.workspacesLoadError).toBeNull();
    expect(store.channelWorkspaces[0].id).toBe('community');
  });
});
