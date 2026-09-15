import { sendChatMessage } from '$lib/utils/chat/messaging';
import { ChannelApiError } from '$lib/services/ChannelService';
import type { Conversation } from '$lib/types';

const sendEncryptedChannelMessage = vi.fn();
vi.mock('$lib/utils/chat/channelCrypto', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    sendEncryptedChannelMessage: (...a: unknown[]) => sendEncryptedChannelMessage(...a),
  };
});

/**
 * A REFUSAL THE SERVER WROTE IN ENGLISH MUST NOT REACH A FRENCH READER.
 *
 * `ChannelService.handleError` throws `ChannelApiError(status, code, text)` where `text` is the
 * server's own body - dev-facing English, which is correct for a log and wrong for a banner. This
 * send site used to interpolate it into `chat_send_error({ reason })`, so a 403 from the channels
 * API was displayed verbatim under a French preamble.
 *
 * It is the ONE of the parked send sites that can close this cheaply, because it is the only one
 * holding an HTTP status at the point of the throw. The assertions therefore have two halves: the
 * status decides the sentence, and the server's words appear in NEITHER outcome.
 */
describe('a refused channel send is described from its status, never from its body', () => {
  const conversation = {
    id: 'channel_c1',
    name: 'channel_c1',
    lifecycle: 'active',
    messages: [],
  } as unknown as Conversation;

  const SERVER_WORDS = 'You are not a member of this channel';

  function deps() {
    return {
      userId: 'me',
      conversation,
      deviceKeyB64: 'k',
      mlsService: {} as unknown,
      log: () => {},
      addMessageToChat: async () => {},
    } as never;
  }

  beforeEach(() => {
    sendEncryptedChannelMessage.mockReset();
  });

  it('turns a mapped status into our own sentence', async () => {
    sendEncryptedChannelMessage.mockImplementation(() =>
      Promise.reject(new ChannelApiError(403, null, SERVER_WORDS))
    );

    const result = await sendChatMessage('hello', 'channel_c1', null, deps());

    // Without this the whole suite would pass vacuously on a mock that never ran.
    expect(sendEncryptedChannelMessage).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain(SERVER_WORDS);
    // 403 is one `describeApiRefusal` maps, so the line names the action rather than staying generic.
    expect(result.error).toContain('message');
  });

  it('falls back to a generic line of OUR OWN for a status it cannot describe', async () => {
    // 500 is deliberately not in the map: `describeApiRefusal` answers null rather than inventing a
    // reason, and what must NOT happen is the caller reaching for the body instead.
    sendEncryptedChannelMessage.mockImplementation(() =>
      Promise.reject(new ChannelApiError(500, null, SERVER_WORDS))
    );

    const result = await sendChatMessage('hello', 'channel_c1', null, deps());

    expect(result.success).toBe(false);
    expect(result.error).not.toContain(SERVER_WORDS);
  });

  it('says nothing of an error that never crossed the network either', async () => {
    // A seal failure carries no status at all. Its message is ours and still English, so the same
    // rule applies: it belongs in the log, not in the banner.
    sendEncryptedChannelMessage.mockImplementation(() =>
      Promise.reject(new Error('sealChannelMessage: no session'))
    );

    const result = await sendChatMessage('hello', 'channel_c1', null, deps());

    expect(result.success).toBe(false);
    expect(result.error).not.toContain('sealChannelMessage');
  });
});
