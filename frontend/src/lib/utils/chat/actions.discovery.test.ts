import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';
import { discoverMissingGroups } from './actions';
import {
  forgetMlsGroupIfPresent,
  purgeLocalConversationRecord,
  purgeOrphanGroup,
} from './groupActions';

vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

function makeMls(overrides: Partial<IMlsService> = {}): IMlsService {
  return {
    getUserGroups: vi.fn().mockResolvedValue([]),
    getLocalGroups: vi.fn().mockReturnValue([]),
    forgetGroup: vi.fn(),
    saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
    ...overrides,
  } as unknown as IMlsService;
}

describe('forgetMlsGroupIfPresent', () => {
  it('calls forgetGroup only when WASM knows the group', () => {
    const mlsService = makeMls({
      getLocalGroups: vi.fn().mockReturnValue(['g1']),
    });
    expect(forgetMlsGroupIfPresent(mlsService, 'g1')).toBe(true);
    expect(mlsService.forgetGroup).toHaveBeenCalledWith('g1', 0);
    expect(forgetMlsGroupIfPresent(mlsService, 'missing')).toBe(false);
  });
});

describe('purgeLocalConversationRecord', () => {
  it('removes map entry and IndexedDB row without touching MLS', async () => {
    const conversations = new Map<string, Conversation>([
      [
        'g1',
        {
          id: 'g1',
          contactName: 'g1',
          name: 'Test',
          messages: [],
          isReady: true,
          mlsStateHex: null,
        },
      ],
    ]);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls();

    await purgeLocalConversationRecord({
      conversations,
      contactKey: 'g1',
      groupId: 'g1',
      deleteConversation,
    });

    expect(conversations.has('g1')).toBe(false);
    expect(deleteConversation).toHaveBeenCalledWith('g1');
    expect(mlsService.forgetGroup).not.toHaveBeenCalled();
  });
});

describe('purgeOrphanGroup', () => {
  it('forgets MLS then persists state then drops UI row', async () => {
    const conversations = new Map<string, Conversation>([
      [
        'g1',
        {
          id: 'g1',
          contactName: 'g1',
          name: 'Test',
          messages: [],
          isReady: true,
          mlsStateHex: null,
        },
      ],
    ]);
    const mlsService = makeMls({
      getLocalGroups: vi.fn().mockReturnValue(['g1']),
    });

    await purgeOrphanGroup({
      conversations,
      mlsService,
      userId: 'user-a',
      pin: '1234',
      contactKey: 'g1',
      groupId: 'g1',
    });

    expect(mlsService.forgetGroup).toHaveBeenCalledWith('g1', 0);
    expect(mlsService.saveState).toHaveBeenCalledWith('1234');
    expect(conversations.has('g1')).toBe(false);
  });
});

describe('discoverMissingGroups orphan cleanup', () => {
  it('purges UI row when absent from server', async () => {
    const conversations = new Map<string, Conversation>([
      [
        'orphan-id',
        {
          id: 'orphan-id',
          contactName: 'orphan-id',
          name: 'Orphelin',
          messages: [],
          isReady: true,
          mlsStateHex: null,
        },
      ],
    ]);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([]),
      getLocalGroups: vi.fn().mockReturnValue([]),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      pin: '1234',
      conversations,
      deleteConversation,
      log: vi.fn(),
    });

    expect(conversations.has('orphan-id')).toBe(false);
    expect(deleteConversation).toHaveBeenCalledWith('orphan-id');
  });

  it('forgets phantom MLS group even without UI conversation row', async () => {
    const conversations = new Map<string, Conversation>();
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([]),
      getLocalGroups: vi.fn().mockReturnValue(['phantom-mls']),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      pin: '1234',
      conversations,
      log: vi.fn(),
    });

    expect(mlsService.forgetGroup).toHaveBeenCalledWith('phantom-mls', 0);
    expect(mlsService.saveState).toHaveBeenCalledWith('1234');
  });

  it('keeps successor conversation referenced by a server tombstone', async () => {
    const conversations = new Map<string, Conversation>([
      [
        'successor-id',
        {
          id: 'successor-id',
          contactName: 'bob',
          name: 'bob',
          messages: [],
          isReady: false,
          mlsStateHex: null,
        },
      ],
    ]);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([
        {
          groupId: 'dead-id',
          name: 'user-a::bob',
          isGroup: false,
          deletedAt: '2026-01-01T00:00:00Z',
          successorId: 'successor-id',
        },
      ]),
      getLocalGroups: vi.fn().mockReturnValue([]),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      pin: '1234',
      conversations,
      deleteConversation,
      log: vi.fn(),
    });

    expect(conversations.has('successor-id')).toBe(true);
    expect(deleteConversation).not.toHaveBeenCalled();
  });

  it('does not purge when server fetch failed', async () => {
    const conversations = new Map<string, Conversation>([
      [
        'orphan-id',
        {
          id: 'orphan-id',
          contactName: 'orphan-id',
          name: 'Orphelin',
          messages: [],
          isReady: true,
          mlsStateHex: null,
        },
      ],
    ]);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockRejectedValue(new Error('network')),
      getLocalGroups: vi.fn().mockReturnValue(['orphan-id']),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      pin: '1234',
      conversations,
      deleteConversation,
      log: vi.fn(),
    });

    expect(conversations.has('orphan-id')).toBe(true);
    expect(deleteConversation).not.toHaveBeenCalled();
    expect(mlsService.forgetGroup).not.toHaveBeenCalled();
  });
});
