// @vitest-environment happy-dom
import { sendRegisterAnswer } from './groupActions';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { decodeAppMessage } from '$lib/proto/codec';
import type { IStorage } from '$lib/db';
import { historySealAad, mintHistoryAnswerKey, openHistoryContent } from '$lib/crypto/historySeal';
import { digestIdentity } from './historyDigestRendezvous';
import { bindHistoryWithheld, withholdHistoryFrom } from './historyWithheld';
import {
  applyNickname,
  resetConversationNicknamesForTests,
} from '$lib/utils/users/conversationNicknames.svelte';
import type { FrameDelivery } from '$lib/mls-client/frameDelivery';

/**
 * THE RESPONDER'S HALF OF THE REGISTER ASK (`registerOwed.ts`, history-answer-addressing.md, "The
 * newcomer asks for its register"): one frame holding the conversation's state and no message,
 * addressed to the asker alone and sealed to its ask - never broadcast, never in clear.
 */
const GROUP = 'g1';
const ASKER = 'user-b:device-b';
const ANSWERER = digestIdentity('user-a', 'device-a');
const REQUEST = 'req-0000000a';

function storage(): IStorage {
  return { getConversation: vi.fn().mockResolvedValue(null) } as unknown as IStorage;
}

async function answer(mlsService: ReturnType<typeof createMlsServiceStub>, log = vi.fn()) {
  const key = await mintHistoryAnswerKey(mlsService.historySealEngine());
  const sent = await sendRegisterAnswer(
    GROUP,
    { storage: storage(), deviceKeyB64: 'k', mlsService, log },
    { to: ASKER, requestId: REQUEST, seal: { answerKey: key.answerKey, answerer: ANSWERER } }
  );
  return { key, sent, log };
}

function frames(mlsService: ReturnType<typeof createMlsServiceStub>) {
  return vi.mocked(mlsService.sendMessage).mock.calls.map(([, bytes, , delivery]) => ({
    body: JSON.parse(decodeAppMessage(bytes as Uint8Array)?.system?.data ?? '{}') as Record<
      string,
      unknown
    >,
    delivery: delivery as FrameDelivery,
  }));
}

describe('sendRegisterAnswer', () => {
  beforeEach(() => {
    localStorage.clear();
    resetConversationNicknamesForTests();
    applyNickname(GROUP, 'user-c', { nickname: 'Capitaine', setBy: 'user-a', at: 10 });
  });
  afterEach(() => {
    bindHistoryWithheld([], null);
    vi.restoreAllMocks();
  });

  it('sends ONE sealed frame, addressed to the asker, whose content is the register and no message', async () => {
    const mlsService = createMlsServiceStub();
    const { key, sent } = await answer(mlsService);

    expect(sent).toBe(true);
    const [frame, ...rest] = frames(mlsService);
    expect(rest).toEqual([]);
    expect(frame.delivery.recipients).toEqual([ASKER]);
    // The routing in clear says only where it goes and which ask it answers - never `register`,
    // and never `last`: the diff that follows closes the ask.
    expect(Object.keys(frame.body).sort()).toEqual(['requestId', 'sealed', 'to']);
    const content = await openHistoryContent(
      mlsService.historySealEngine(),
      key.secret,
      historySealAad(GROUP, REQUEST, ASKER, ANSWERER),
      frame.body.sealed as string
    );
    expect(content).toMatchObject({
      messages: [],
      register: true,
      nicknames: [expect.objectContaining({ userId: 'user-c', nickname: 'Capitaine' })],
    });
  });

  it('is never broadcast - a server that does not address gets no register at all', async () => {
    const mlsService = createMlsServiceStub();
    vi.mocked(mlsService.getAddressedAnswersSupported).mockResolvedValue(false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sent, log } = await answer(mlsService);

    expect(sent).toBe(false);
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('a register is never broadcast'));
  });

  it('is withheld from an unvouched device, like every other history answer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mlsService = createMlsServiceStub();
    await withholdHistoryFrom(GROUP, ASKER, 'fp-1', async () => true);
    const { sent, log } = await answer(mlsService);

    expect(sent).toBe(false);
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unvouched'));
  });

  it('an engine that cannot seal sends nothing - never the register in clear', async () => {
    const mlsService = createMlsServiceStub();
    const key = await mintHistoryAnswerKey(mlsService.historySealEngine());
    vi.mocked(mlsService.historySealEngine).mockReturnValue({
      newAnswerKeyPair: vi.fn(),
      seal: vi.fn().mockRejectedValue('malformed-public-key'),
      open: vi.fn(),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const sent = await sendRegisterAnswer(
      GROUP,
      { storage: storage(), deviceKeyB64: 'k', mlsService, log: vi.fn() },
      { to: ASKER, requestId: REQUEST, seal: { answerKey: key.answerKey, answerer: ANSWERER } }
    );

    expect(sent).toBe(false);
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(error.mock.calls.join(' ')).toContain('Could not seal');
  });
});
