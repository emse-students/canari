/**
 * A VIDEO PICKED IN THE CHAT IS RE-ENCODED ON THE DEVICE BEFORE IT IS STAGED (decision C3).
 *
 * So its picked size is no reason to refuse it - a 200 MB camera clip leaves as ~30 MB - and the
 * server's ceiling becomes the encoder's budget instead. What is staged is the PREPARED file with
 * its own frame size; a refusal names its cause on the banner; a cancel says nothing; and the
 * progress the composer draws comes and goes with the run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

const prepareMock = vi.fn();
vi.mock('$lib/video/prepareVideoForUpload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/video/prepareVideoForUpload')>();
  return { ...actual, prepareVideoForUpload: (...args: unknown[]) => prepareMock(...args) };
});

await import('./useMessaging.svelte');

type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';
import type { PrepareVideoOptions } from '$lib/video/prepareVideoForUpload';

const CONVO = 'conversation-key';
const SERVER_MAX_BYTES = 50 * 1024 * 1024;

const videoOf = (size: number): File =>
  ({ size, name: 'clip.mov', type: 'video/quicktime' }) as unknown as File;

function makeContext() {
  const conversations = new SvelteMap<string, Conversation>([
    [CONVO, { id: CONVO, name: CONVO, messages: [], unreadCount: 0, lastMessageAt: 0 } as never],
  ]);
  return {
    conversations,
    selectedContact: CONVO,
    setSendError: vi.fn(),
    log: vi.fn(),
  } as unknown as MessagingContext;
}

async function freshMessaging() {
  vi.resetModules();
  const { useMessaging } = await import('./useMessaging.svelte');
  return useMessaging();
}

/**
 * The error class of the CURRENT module registry - `freshMessaging` resets it, and a refusal built
 * from the previous registry's class would fail the composable's `instanceof`.
 */
async function freshError(fault: 'unsupported' | 'aborted') {
  const { VideoPrepareError } = await import('$lib/video/prepareVideoForUpload');
  return new VideoPrepareError(fault, fault);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  prepareMock.mockReset();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        ({ ok: true, status: 200, json: async () => ({ maxBytes: SERVER_MAX_BYTES }) }) as Response
    )
  );
});

describe('a video picked in the chat', () => {
  it('is prepared, not refused by its picked size, and staged as the prepared file', async () => {
    const prepared = new File([new Uint8Array(4)], 'clip.mp4', {
      type: 'video/mp4; codecs="avc1.64001f, mp4a.40.2"',
    });
    let fractionSeen: number | null = null;
    const messaging = await freshMessaging();
    prepareMock.mockImplementation(async (_file: File, options: PrepareVideoOptions) => {
      options.onProgress?.(0.4);
      fractionSeen = messaging.videoPreparation.fraction;
      return {
        file: prepared,
        width: 720,
        height: 1280,
        durationSeconds: 20,
        sourceBytes: 200 * 1024 * 1024,
        outputBytes: 4,
      };
    });
    const ctx = makeContext();

    await messaging.handleFilesSelected([videoOf(200 * 1024 * 1024)], ctx);

    expect(ctx.setSendError).not.toHaveBeenCalled();
    // The encoder's budget is the server's ceiling, less what encryption adds.
    const options = prepareMock.mock.calls[0][1] as PrepareVideoOptions;
    expect(options.maxBytes).toBeGreaterThan(SERVER_MAX_BYTES - 1024);
    expect(options.maxBytes).toBeLessThan(SERVER_MAX_BYTES);
    expect(messaging.pendingMediaFiles).toEqual([{ file: prepared, width: 720, height: 1280 }]);
    expect(fractionSeen).toBe(0.4);
    expect(messaging.videoPreparation.fraction).toBeNull();
  });

  it('names a refusal on the banner and stages nothing', async () => {
    const messaging = await freshMessaging();
    prepareMock.mockRejectedValue(await freshError('unsupported'));
    const ctx = makeContext();

    await messaging.handleFilesSelected([videoOf(1000)], ctx);

    expect(ctx.setSendError).toHaveBeenCalledTimes(1);
    expect(messaging.pendingMediaFiles).toEqual([]);
  });

  it('says nothing for a cancel the member asked for', async () => {
    const messaging = await freshMessaging();
    prepareMock.mockRejectedValue(await freshError('aborted'));
    const ctx = makeContext();

    await messaging.handleFilesSelected([videoOf(1000)], ctx);

    expect(ctx.setSendError).not.toHaveBeenCalled();
    expect(messaging.pendingMediaFiles).toEqual([]);
  });

  it('prepares two picks one after the other, never at once', async () => {
    const order: string[] = [];
    prepareMock.mockImplementation(async (file: File) => {
      order.push(`start ${file.name}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end ${file.name}`);
      return { file, width: 2, height: 2, durationSeconds: 1, sourceBytes: 1, outputBytes: 1 };
    });
    const messaging = await freshMessaging();
    const ctx = makeContext();
    const a = { ...videoOf(10), name: 'a.mov' } as unknown as File;
    const b = { ...videoOf(10), name: 'b.mov' } as unknown as File;

    await Promise.all([
      messaging.handleFilesSelected([a], ctx),
      messaging.handleFilesSelected([b], ctx),
    ]);

    expect(order).toEqual(['start a.mov', 'end a.mov', 'start b.mov', 'end b.mov']);
  });
});
