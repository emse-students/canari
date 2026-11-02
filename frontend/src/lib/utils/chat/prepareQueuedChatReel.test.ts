import { describe, expect, it, vi } from 'vitest';
import { prepareQueuedChatReel, type PrepareQueuedChatReelDeps } from './prepareQueuedChatReel';
import { OutboxPrepareRefusedError } from './outbox';
import { ChatReelCapMissingError } from '$lib/reels/chatReelWriter';
import { UploadAbortedError } from '$lib/utils/uploadXhr';
import type { ReelLimits } from '$lib/posts/api';

const MEDIA = {
  fileBytes: new Uint8Array([1, 2, 3]),
  fileName: 'take.webm',
  mimeType: 'video/webm',
  size: 3,
} as unknown as Parameters<typeof prepareQueuedChatReel>[0];

const LIMITS: ReelLimits = {
  maxDurationMs: 90_000,
  chatMaxDurationMs: 60_000,
  retentionDays: 30,
  warningWindowDays: 7,
};

function deps(over: Partial<PrepareQueuedChatReelDeps> = {}) {
  const prepare = vi.fn(async () => ({
    file: new File([new Uint8Array([9])], 'take.mp4', { type: 'video/mp4' }),
    width: 540,
    height: 960,
    durationSeconds: 12,
    sourceBytes: 3,
    outputBytes: 1,
  }));
  return {
    prepare,
    deps: {
      uploadLimits: async () => ({ maxPlaintextBytes: 50_000_000 }),
      reelLimits: async () => LIMITS,
      prepare,
      ...over,
    } satisfies PrepareQueuedChatReelDeps,
  };
}

const opts = () => ({ signal: new AbortController().signal, onProgress: () => undefined });

describe('prepareQueuedChatReel', () => {
  it('prepares at the chat profile under the 60 s chat cap', async () => {
    const d = deps();
    const out = await prepareQueuedChatReel(MEDIA, opts(), d.deps);
    expect(d.prepare).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ profile: 'chat', maxSeconds: 60, maxBytes: 50_000_000 })
    );
    expect(out.durationMs).toBe(12_000);
  });

  it('a cap that cannot be read (getReelLimits rejects) is an ORDINARY failure - the outbox parks the take - and nothing is encoded', async () => {
    const offline = new TypeError('Failed to fetch');
    const d = deps({ reelLimits: () => Promise.reject(offline) });
    const err = await prepareQueuedChatReel(MEDIA, opts(), d.deps).catch((e: unknown) => e);
    expect(err).toBe(offline);
    expect(err).not.toBeInstanceOf(OutboxPrepareRefusedError);
    expect(err).not.toBeInstanceOf(UploadAbortedError);
    expect(d.prepare).not.toHaveBeenCalled();
  });

  it('an answer without the chat cap parks the take too: never prepared under the 90 s reel cap', async () => {
    const { chatMaxDurationMs: _gone, ...older } = LIMITS;
    const d = deps({ reelLimits: async () => older as unknown as ReelLimits });
    const err = await prepareQueuedChatReel(MEDIA, opts(), d.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatReelCapMissingError);
    expect(err).not.toBeInstanceOf(OutboxPrepareRefusedError);
    expect(d.prepare).not.toHaveBeenCalled();
  });
});
