import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaService, resumableEncodingFor, type MediaRef } from '$lib/media';
import { MEDIA_REQUEST_BODY_BUDGET_BYTES } from '$lib/utils/mediaRequestLimits';

/**
 * THE ROUTE OF A QUEUED CHAT ATTACHMENT (2026-11-16). On the iPhone 12 a 13 631 488-byte file read
 * 50 %, then 6 %: it took the legacy chunk route, whose every attempt opens a fresh uploadId and
 * sends the whole file again from byte 0. Over one request body it now takes a resumable session.
 */
describe('MediaService.uploadQueuedAttachment', () => {
  const REF = { mediaId: 'm', key: 'k', iv: 'i' } as unknown as MediaRef;
  const token = async () => 'tok';
  const persist = async () => undefined;

  afterEach(() => vi.restoreAllMocks());

  function spies() {
    const resumable = vi.spyOn(MediaService.prototype, 'uploadResumably').mockResolvedValue(REF);
    const oneShot = vi.spyOn(MediaService.prototype, 'encryptAndUpload').mockResolvedValue(REF);
    return { resumable, oneShot };
  }

  it('sends the 13 MB file of the iPhone reading through a resumable session, as ONE block', async () => {
    const { resumable, oneShot } = spies();
    const state = { keyHex: 'aa', ivHex: 'bb', plaintextSha256: 'cc', plaintextBytes: 13_631_488 };
    await new MediaService().uploadQueuedAttachment(
      new Uint8Array(13_631_488),
      { mimeType: 'application/octet-stream', fileName: 'blob13.bin' },
      token,
      undefined,
      'ephemeral',
      { state, persist }
    );
    expect(oneShot).not.toHaveBeenCalled();
    expect(resumable).toHaveBeenCalledTimes(1);
    // The recorded session is handed on, so a relaunch resumes it; the format is the one the
    // one-shot route wrote for this type, so every reader opens it the same way.
    expect(resumable.mock.calls[0][5]).toMatchObject({ state, encoding: 'single-block' });
    expect(resumable.mock.calls[0][4]).toBe('ephemeral');
  });

  it('keeps the one-shot route metadata on the session route: a name of "file", a lower-cased type', async () => {
    const { resumable } = spies();
    await new MediaService().uploadQueuedAttachment(
      new Uint8Array(13_631_488),
      { mimeType: 'Application/PDF' },
      token,
      undefined,
      'ephemeral',
      { persist }
    );
    expect(resumable.mock.calls[0][1]).toEqual({ mimeType: 'application/pdf', fileName: 'file' });
  });

  it('keeps a file that fits one request body on the single POST', async () => {
    const { resumable, oneShot } = spies();
    await new MediaService().uploadQueuedAttachment(
      new Uint8Array(300_000),
      { mimeType: 'image/webp' },
      token,
      { width: 10, height: 10 },
      'ephemeral',
      { persist }
    );
    expect(resumable).not.toHaveBeenCalled();
    expect(oneShot).toHaveBeenCalledTimes(1);
    const file = oneShot.mock.calls[0][0];
    expect(file.size).toBe(300_000);
    expect(oneShot.mock.calls[0][1]).toBe('tok');
  });

  it('a chat reel is always a segmented session, whatever its size', async () => {
    const { resumable } = spies();
    await new MediaService().uploadQueuedAttachment(
      new Uint8Array(1000),
      { mimeType: 'video/mp4' },
      token,
      undefined,
      'chat-reel',
      { persist }
    );
    expect(resumable.mock.calls[0][5]).toMatchObject({ encoding: 'segmented-v1' });
  });

  it('without a place to record a session, nothing takes one', async () => {
    const { resumable, oneShot } = spies();
    await new MediaService().uploadQueuedAttachment(
      new Uint8Array(13_631_488),
      { mimeType: 'application/pdf' },
      token,
      undefined,
      'ephemeral'
    );
    expect(resumable).not.toHaveBeenCalled();
    expect(oneShot).toHaveBeenCalledTimes(1);
  });

  it('uploads the bytes of the VIEW, never the larger buffer around it', async () => {
    const { oneShot } = spies();
    const backing = new Uint8Array(1000);
    await new MediaService().uploadQueuedAttachment(
      backing.subarray(100, 400),
      { mimeType: 'application/pdf' },
      token,
      undefined,
      'ephemeral',
      { persist }
    );
    expect(oneShot.mock.calls[0][0].size).toBe(300);
  });
});

describe('resumableEncodingFor', () => {
  it('draws the line where one request body ends: the 16-byte tag included', () => {
    const fits = MEDIA_REQUEST_BODY_BUDGET_BYTES - 16;
    expect(resumableEncodingFor(fits, 'application/pdf')).toBeNull();
    expect(resumableEncodingFor(fits + 1, 'application/pdf')).toBe('single-block');
  });
});
