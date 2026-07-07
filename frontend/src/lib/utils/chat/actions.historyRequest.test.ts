import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Conversation } from '$lib/types';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';

// Mock only the shared history-bundle sender so we can assert whether it is invoked, keeping the
// rest of groupActions (persist helpers, etc.) intact for actions.ts.
const { sendFullHistoryBundle } = vi.hoisted(() => ({
  sendFullHistoryBundle: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/utils/chat/groupActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/groupActions')>();
  return { ...actual, sendFullHistoryBundle };
});

import { handleHistoryRequest } from './actions';

function activeConversations(groupId: string): Map<string, Conversation> {
  return new Map([
    [
      groupId,
      {
        id: groupId,
        contactName: groupId,
        name: 'Test',
        messages: [],
        lifecycle: 'active',
        mlsStateHex: null,
      } as Conversation,
    ],
  ]);
}

const base = {
  storage: null,
  pin: 'pin',
  log: vi.fn(),
  requesterUserId: 'u2',
};

describe('handleHistoryRequest', () => {
  beforeEach(() => sendFullHistoryBundle.mockClear());

  it('serves the history bundle when an active member holds the group locally', async () => {
    const groupId = 'g1';
    const mlsService = createMlsServiceStub({
      getLocalGroups: vi.fn().mockReturnValue([groupId]),
    });
    await handleHistoryRequest({
      ...base,
      mlsService,
      conversations: activeConversations(groupId),
      groupId,
    });
    expect(sendFullHistoryBundle).toHaveBeenCalledWith(groupId, expect.anything());
  });

  it('skips when the group is not held locally (cannot re-encrypt history)', async () => {
    const groupId = 'g1';
    const mlsService = createMlsServiceStub({
      getLocalGroups: vi.fn().mockReturnValue([]),
    });
    await handleHistoryRequest({
      ...base,
      mlsService,
      conversations: activeConversations(groupId),
      groupId,
    });
    expect(sendFullHistoryBundle).not.toHaveBeenCalled();
  });

  it('skips when the conversation is not active locally', async () => {
    const groupId = 'g1';
    const mlsService = createMlsServiceStub({
      getLocalGroups: vi.fn().mockReturnValue([groupId]),
    });
    await handleHistoryRequest({
      ...base,
      mlsService,
      conversations: new Map(),
      groupId,
    });
    expect(sendFullHistoryBundle).not.toHaveBeenCalled();
  });
});
