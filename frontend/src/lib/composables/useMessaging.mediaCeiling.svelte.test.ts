/**
 * THE UPLOAD CEILING IS THE SERVER'S NUMBER, AND THE CLIENT ASKS FOR IT.
 *
 * It used to be `VITE_MEDIA_MAX_SIZE_MB`, inlined at BUILD time. Nothing in `build.yml` ever wrote
 * that variable - only `scripts/setup-env.sh`, on a developer's machine - so every shipped build
 * (web, APK, iOS) refused at the code default of 100 MB while every server has run on
 * `MEDIA_MAX_SIZE_MB=50`. Measured on the local estate 2026-09-24 by asking the server directly:
 * 49 MB answers `201`, 51 MB answers `413 File too large`. A member could pick a 90 MB video, watch
 * the whole of it go up, and be refused at the end; `client_max_body_size 100m` on nginx, long
 * believed to be the opposing side, never got a say.
 *
 * THE TWO NUMBERS ALSO MEASURED DIFFERENT BYTES. The server's ceiling applies to the CIPHERTEXT and
 * the picker holds a PLAINTEXT file, which AES-GCM grows by exactly its 16-byte tag - the IV travels
 * beside the blob, not inside it. So a file of exactly `maxBytes` does not fit, and that boundary is
 * asserted here rather than left to arithmetic nobody re-does.
 *
 * AND WHEN THE LIMIT CANNOT BE HAD, NOTHING IS REFUSED HERE. The client check is an optimisation -
 * telling a member before the bytes go up rather than after - and the refusal that matters is the
 * server's 413. A `null` ceiling must never become a made-up one, which is what a default would be.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

// Same import-cycle break as the other useMessaging tests: useMessaging -> chat/outbox ->
// chat/outboxMirror -> globalChatSingleton, which calls useMessaging() at module scope.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

// THE COLD IMPORT IS PAID HERE, BEFORE ANY CASE'S CLOCK RUNS. `freshMessaging` resets the module
// registry per case, and the first import of this graph costs seconds - inside a case that reads as
// a hang and trips the 5 s default. Vitest keeps the TRANSFORM across a reset, so every later import
// is cheap; only the first one is not.
await import('./useMessaging.svelte');

type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';

const CONVO = 'conversation-key';
/** What every server in this estate is configured with, and what the fixture server answers. */
const SERVER_MAX_BYTES = 50 * 1024 * 1024;
/** The AES-GCM tag, the whole of the difference between the file and what the server measures. */
const TAG = 16;

/**
 * A file this test never allocates. `prepareMediaFiles` reads `size`, `type` and `name` and nothing
 * else for a non-image, so fifty megabytes of zeroes would only slow the suite down.
 */
const fileOf = (size: number): File =>
  ({ size, name: 'clip.bin', type: 'application/octet-stream' }) as unknown as File;

function makeContext() {
  const conversations = new SvelteMap<string, Conversation>([
    [CONVO, { id: CONVO, name: CONVO, messages: [], unreadCount: 0, lastMessageAt: 0 } as never],
  ]);
  return {
    conversations,
    userId: 'me-user-id',
    deviceKeyB64: 'device-key',
    authToken: 'token',
    selectedContact: CONVO,
    storage: { saveMessage: vi.fn().mockResolvedValue(undefined) } as never,
    setAuthToken: vi.fn(),
    getSendError: () => '',
    setSendError: vi.fn(),
    ensureMls: vi.fn(),
    log: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    verifyCurrentUserMembership: vi.fn().mockResolvedValue(true),
    playNotificationTone: vi.fn(),
    playReceiveTone: vi.fn(),
    sendSystemNotification: vi.fn().mockResolvedValue(undefined),
  } as unknown as MessagingContext;
}

/**
 * A messaging composable whose media ceiling has not been asked for yet.
 *
 * The cache is module-level and keyed by origin, which is the right shape in a browser and sticky in
 * a suite: without the reset the SECOND case here would be answered by the FIRST case's fixture.
 */
async function freshMessaging() {
  vi.resetModules();
  const { useMessaging } = await import('./useMessaging.svelte');
  return useMessaging();
}

/** A media service that answers `/media/limits` with `maxBytes`, or refuses to answer at all. */
function serverAnswering(maxBytes: number | 'unreachable') {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes('/api/media/limits')) throw new Error(`unexpected request to ${url}`);
    if (maxBytes === 'unreachable') throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, json: async () => ({ maxBytes }) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('the upload ceiling comes from the server, not from the build', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('refuses a file the server would refuse, and names the SERVER number', async () => {
    serverAnswering(SERVER_MAX_BYTES);
    const messaging = await freshMessaging();
    const ctx = makeContext();

    // 90 MB: under the 100 MB the shipped client used to allow, over the 50 MB every server runs.
    await messaging.handleFilesSelected([fileOf(90 * 1024 * 1024)], ctx);

    expect(ctx.setSendError).toHaveBeenCalledTimes(1);
    // The banner interpolates the limit in MB. `49` would mean the tag was subtracted twice; `100`
    // would mean the build-time number is still in play, which is the whole defect.
    const said = String((ctx.setSendError as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(said).toContain('50');
    expect(said).not.toContain('100');
  });

  it('puts the AES-GCM tag on the right side of the boundary', async () => {
    serverAnswering(SERVER_MAX_BYTES);
    const messaging = await freshMessaging();
    const ctx = makeContext();

    // Exactly the server's ceiling as PLAINTEXT is 16 bytes too big once encrypted.
    await messaging.handleFilesSelected([fileOf(SERVER_MAX_BYTES)], ctx);
    expect(ctx.setSendError).toHaveBeenCalledTimes(1);

    // One byte under that is the largest file that fits, and it must not be refused.
    const ctx2 = makeContext();
    await messaging.handleFilesSelected([fileOf(SERVER_MAX_BYTES - TAG)], ctx2);
    expect(ctx2.setSendError).not.toHaveBeenCalled();
  });

  it('asks the server ONCE however many pickers run', async () => {
    const fetchMock = serverAnswering(SERVER_MAX_BYTES);
    const messaging = await freshMessaging();
    const ctx = makeContext();

    await messaging.handleFilesSelected([fileOf(1024)], ctx);
    await messaging.handleFilesSelected([fileOf(2048)], ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses NOTHING when the limit cannot be had, and leaves the 413 to decide', async () => {
    serverAnswering('unreachable');
    const messaging = await freshMessaging();
    const ctx = makeContext();

    // Far over every ceiling this estate has ever had. An invented default would refuse it here,
    // which is exactly the behaviour this replaced.
    await messaging.handleFilesSelected([fileOf(900 * 1024 * 1024)], ctx);

    expect(ctx.setSendError).not.toHaveBeenCalled();
  });
});
