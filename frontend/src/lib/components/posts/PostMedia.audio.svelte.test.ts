// @vitest-environment happy-dom
/**
 * AN AUDIO FILE OF A POST IS PLAYED BY THE VOICE-NOTE PLAYER, NEVER BY THE ENGINE'S `controls`
 * (owner inventory, 2026-11-26): the conversations' strip, speed control and loudness law, for any
 * audio. Pinned: the player is `VoiceMessagePlayer` fed the decrypted URL, the declared type and the
 * publisher's measured loudness, and no `<audio>` of this component carries `controls`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const cache = vi.hoisted(() => ({
  retainWarmDecryptedMediaBlobUrl: vi.fn(() => null),
  releaseDecryptedMediaBlobUrl: vi.fn(),
}));
const download = vi.hoisted(() => vi.fn<() => Promise<string>>());

vi.mock('$lib/utils/mediaBlobCache', () => cache);
vi.mock('$lib/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/media')>()),
  MediaService: class {
    downloadAndDecrypt = download;
  },
}));
vi.mock('$lib/components/messages/VoiceMessagePlayer.svelte', async () => ({
  default: (await import('./PostAudioPlayerStub.test-helper.svelte')).default,
}));

import PostMedia from './PostMedia.svelte';

const loudness = { integratedLufs: -20, samplePeakDbfs: -3 };
const AUDIO = {
  type: 'audio' as const,
  mediaId: 'a1',
  key: 'k',
  iv: 'iv',
  mimeType: 'audio/mpeg',
  size: 1,
  loudness,
};
const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('PostMedia - an audio file is the voice-note player', () => {
  it('hands it the decrypted URL, the declared type and the measured loudness', async () => {
    download.mockResolvedValue('blob:song');
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(PostMedia, { target, props: { media: AUDIO, authToken: 'token' } });
    mounted.push(() => unmount(component));
    flushSync();
    await tick();
    await tick();
    flushSync();
    const stub = target.querySelector<HTMLElement>('[data-audio-player-stub]')!;
    expect(stub.dataset.src).toBe('blob:song');
    expect(stub.dataset.mimeType).toBe('audio/mpeg');
    expect(stub.dataset.loudness).toBe(JSON.stringify(loudness));
    expect(target.querySelector('audio[controls]')).toBeNull();
  });
});
