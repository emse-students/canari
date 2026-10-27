// @vitest-environment happy-dom
/**
 * The DM/group live path draws a CanaRun card and a kind newer than this build. Its branch used to
 * be `text || reply || media`, so both were ACKed and never shown (CanaRun R1).
 */
vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
  saveMlsStateEncrypted: vi.fn().mockResolvedValue(undefined),
  purgeLegacyPlainMlsState: vi.fn().mockResolvedValue(undefined),
}));

import protobuf from 'protobufjs/minimal.js';
import { setupMessageHandler } from './setupMessageHandler';
import { encodeAppMessage, mkEdit, mkRun } from '$lib/proto/codec';
import { parseEnvelope, mkRunEnvelope } from '$lib/envelope';
import { runActivityToProto } from '$lib/canarun/activity';
import { sampleRun } from '../../../test/canarunFixture';
import { createMlsServiceStub } from '../test/fixtures/mlsServiceStub';
import {
  createTestConversations,
  createTestMessageReactions,
  emptyConversation,
} from '../test/fixtures/conversationMap';

const groupId = '55555555-5555-4555-8555-555555555555';

function deps(plaintext: Uint8Array) {
  return {
    mlsService: createMlsServiceStub({
      getUserGroups: vi.fn().mockResolvedValue([{ groupId, name: 'Test', isGroup: true }]),
      getLocalGroups: vi.fn().mockReturnValue([groupId]),
      processIncomingMessage: vi.fn().mockResolvedValue({ plaintext, author: 'unsigned' }),
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
}

async function deliver(plaintext: Uint8Array) {
  const d = deps(plaintext);
  setupMessageHandler(d as never);
  const onMsg = (d.mlsService as never as { onMessage: { mock: { calls: unknown[][] } } }).onMessage
    .mock.calls[0][0] as (...args: unknown[]) => Promise<boolean>;
  const acked = await onMsg('Peer-User', new Uint8Array([7]), groupId, false, undefined, false, {
    channel: 'live',
    senderDeviceId: 'dev-p',
    queuedMessageId: 'q1',
  });
  return { d, acked };
}

describe('the DM live path and CanaRun', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('draws a run frame as the activity card', async () => {
    const { d, acked } = await deliver(
      encodeAppMessage({ ...mkRun(runActivityToProto(sampleRun())), messageId: 'run-1' })
    );
    expect(acked).toBe(true);
    expect(d.addMessageToChat).toHaveBeenCalledTimes(1);
    const [sender, content, convo, opts] = d.addMessageToChat.mock.calls[0];
    expect(sender).toBe('peer-user');
    expect(convo).toBe(groupId);
    expect(parseEnvelope(content as string)).toEqual(mkRunEnvelope(sampleRun()));
    expect((opts as { messageId: string }).messageId).toBe('run-1');
  });

  it('shows a kind newer than this build instead of dropping it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = protobuf.Writer.create();
    w.uint32((6 << 3) | 2).string('future-1');
    w.uint32((99 << 3) | 2).bytes(new Uint8Array([0x0a, 0x00]));
    const { d } = await deliver(w.finish());
    expect(d.addMessageToChat).toHaveBeenCalledTimes(1);
    expect(parseEnvelope(d.addMessageToChat.mock.calls[0][1] as string)).toEqual({
      kind: 'unsupported',
      reason: 'unknown-kind',
      field: 99,
    });
  });

  it('still draws nothing for a known kind the path has no use for, and says so', async () => {
    const { d } = await deliver(encodeAppMessage(mkEdit('m1', 'x', 1)));
    expect(d.addMessageToChat).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("Frame of kind 'edit'"));
  });
});
