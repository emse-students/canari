// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/hex', () => ({ bytesToHex: (b: Uint8Array) => Array.from(b).join('') }));

const order: string[] = [];

vi.mock('../mlsStatePersister', async (importActual) => {
  const actual = await importActual<typeof import('../mlsStatePersister')>();
  return {
    ...actual,
    createMlsStatePersister: (cfg: never) => {
      const p = actual.createMlsStatePersister(cfg);
      const persistNow = p.persistNow.bind(p);
      p.persistNow = () => {
        order.push('persistNow');
        persistNow();
      };
      return p;
    },
  };
});

import { setupMessageHandler } from './setupMessageHandler';
import { frameFingerprint } from '../inboundFrameLedger';
import * as history from '$lib/utils/chat/history';
import { createMlsServiceStub } from '../test/fixtures/mlsServiceStub';
import {
  createTestConversations,
  createTestMessageReactions,
  emptyConversation,
} from '../test/fixtures/conversationMap';

const groupId = '22222222-2222-4222-8222-222222222222';

describe('a live commit', () => {
  beforeEach(() => {
    order.length = 0;
    localStorage.clear();
    history.resetSeenCipherCacheForTests();
  });

  it('records its seen-frame mark BEFORE it asks for the checkpoint, so one checkpoint makes both durable', async () => {
    const body = [4, 4, 4];
    const mark = vi.spyOn(history, 'markHistoryFrameConsumed').mockImplementation(() => {
      order.push('mark');
    });
    const deps = {
      mlsService: createMlsServiceStub({
        getUserGroups: vi.fn().mockResolvedValue([{ groupId, name: 'Test', isGroup: true }]),
        getLocalGroups: vi.fn().mockReturnValue([groupId]),
        processIncomingMessage: vi.fn().mockResolvedValue(null),
      }),
      storage: null,
      userId: 'user-a',
      deviceKey: () => 'device-key',
      historyBaseUrl: 'https://hist',
      conversations: createTestConversations([
        [groupId, emptyConversation(groupId, { lifecycle: 'active' })],
      ]),
      messageReactions: createTestMessageReactions(),
      recoveryTimers: new Map(),
      getSelectedContact: () => null,
      setSelectedContact: vi.fn(),
      saveConversation: vi.fn().mockResolvedValue(undefined),
      addMessageToChat: vi.fn().mockResolvedValue(undefined),
      loadHistoryForConversation: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
    };
    setupMessageHandler(deps as never);
    const onMsg = (deps.mlsService as never as { onMessage: { mock: { calls: unknown[][] } } })
      .onMessage.mock.calls[0][0] as (...a: unknown[]) => Promise<boolean>;

    await onMsg('peer-user', new Uint8Array(body), groupId, false, undefined, true);

    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith('user-a', groupId, frameFingerprint(new Uint8Array(body)));
    expect(order.indexOf('mark')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('mark')).toBeLessThan(order.indexOf('persistNow'));
  });
});
