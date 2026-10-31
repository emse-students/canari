/**
 * The publish step does the server's contract in its order, sends the payload a reel must carry,
 * and names the stage it stopped at - with every service replaced, so nothing here needs a network
 * or an encoder.
 */
import { describe, expect, it, vi } from 'vitest';
import { ANONYMOUS_POST_IDENTITY } from '$lib/posts/postComposerDraft';
import { VideoPrepareError } from '$lib/video/prepareVideoForUpload';
import { MediaService } from '$lib/media';
import {
  defaultPublishReelDeps,
  declaredReelDurationMs,
  publishCameraPhoto,
  publishReel,
  ReelPublishError,
  type PublishReelDeps,
} from './publishReel';

vi.mock('$lib/stores/user', () => ({ isGlobalAdmin: () => false }));
vi.mock('$lib/media', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/media')>();
  return {
    ...original,
    preparePostMedia: vi.fn(async () => ({
      file: new File([new Uint8Array(4)], 'camera.webp', { type: 'image/webp' }),
      dims: { width: 640, height: 480 },
    })),
  };
});

const ref = {
  type: 'video' as const,
  mediaId: 'm-1',
  key: 'k',
  iv: 'i',
  mimeType: 'video/mp4',
  size: 10,
};

function deps(calls: string[] = []): PublishReelDeps {
  return {
    assertNotMuted: vi.fn(async () => void calls.push('muted')),
    getToken: vi.fn(async () => (calls.push('token'), 'tok')),
    uploadLimits: vi.fn(async () => (calls.push('limits'), { maxPlaintextBytes: 1000 })),
    prepare: vi.fn(async () => {
      calls.push('prepare');
      return {
        file: new File([new Uint8Array(4)], 'reel.mp4', { type: 'video/mp4' }),
        width: 720,
        height: 1280,
        durationSeconds: 12.3456,
        sourceBytes: 8,
        outputBytes: 4,
      };
    }),
    upload: vi.fn(async () => (calls.push('upload'), ref)),
    placeholder: vi.fn(async () => null),
    createPost: vi.fn(async () => {
      calls.push('create');
      return { id: 'p-1' } as never;
    }),
  };
}

const clip = { blob: new Blob(['x'], { type: 'video/webm' }), source: 'camera' as const };

function input(overrides: Partial<Parameters<typeof publishReel>[0]> = {}) {
  return {
    clip,
    caption: 'hello',
    identity: '',
    maxDurationMs: 90_000,
    video: {},
    ...overrides,
  };
}

describe('publishReel', () => {
  it('checks, prepares, uploads, then creates - in that order', async () => {
    const calls: string[] = [];
    const stages: string[] = [];
    await publishReel(input({ onStage: (s) => stages.push(s) }), deps(calls));
    expect(calls).toEqual(['muted', 'token', 'limits', 'prepare', 'upload', 'create']);
    expect(stages).toEqual([
      'moderation',
      'mediaToken',
      'mediaPrepare',
      'mediaUpload',
      'createPost',
    ]);
  });

  it('prepares within the server cap and the upload ceiling', async () => {
    const d = deps();
    await publishReel(input(), d);
    expect(d.prepare).toHaveBeenCalledWith(
      clip.blob,
      expect.objectContaining({ maxSeconds: 90, maxBytes: 1000 })
    );
    expect(d.upload).toHaveBeenCalledWith(expect.any(File), 'tok', { width: 720, height: 1280 });
  });

  it('keeps the sound by default and asks the encoder to REMOVE the audio track when the member did', async () => {
    const kept = deps();
    await publishReel(input(), kept);
    expect(kept.prepare).toHaveBeenCalledWith(
      clip.blob,
      expect.objectContaining({ removeAudio: false, trimToVideo: true })
    );

    const silent = deps();
    const soundless = { ...clip, soundRemoved: true };
    await publishReel(input({ clip: soundless }), silent);
    expect(silent.prepare).toHaveBeenCalledWith(
      soundless.blob,
      expect.objectContaining({ removeAudio: true })
    );
  });

  it('creates a reel with its declared duration, its caption and one video', async () => {
    const d = deps();
    await publishReel(input(), d);
    expect(d.createPost).toHaveBeenCalledWith({
      kind: 'reel',
      durationMs: 12346,
      markdown: 'hello',
      media: [ref],
    });
  });

  it('carries the first frame ThumbHash of the uploaded file in the reel media', async () => {
    const d = deps();
    d.placeholder = vi.fn(async () => 'TH==');
    await publishReel(input(), d);
    const prepared = (await (d.prepare as ReturnType<typeof vi.fn>).mock.results[0].value).file;
    expect(d.placeholder).toHaveBeenCalledWith(prepared);
    expect(d.createPost).toHaveBeenCalledWith(
      expect.objectContaining({ media: [{ ...ref, placeholder: 'TH==' }] })
    );
  });

  it('publishes as an association or anonymously, as a post would', async () => {
    const asso = deps();
    await publishReel(input({ identity: 'asso-1' }), asso);
    expect(asso.createPost).toHaveBeenCalledWith(
      expect.objectContaining({ associationId: 'asso-1' })
    );
    const anon = deps();
    await publishReel(input({ identity: ANONYMOUS_POST_IDENTITY }), anon);
    expect(anon.createPost).toHaveBeenCalledWith(expect.objectContaining({ anonymous: true }));
  });

  it('names the stage it stopped at and keeps the cause', async () => {
    const d = deps();
    const cause = new VideoPrepareError('unsupported', 'no');
    vi.mocked(d.prepare).mockRejectedValueOnce(cause);
    const err = await publishReel(input(), d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReelPublishError);
    expect((err as ReelPublishError).stage).toBe('mediaPrepare');
    expect((err as ReelPublishError).cause).toBe(cause);
    expect(d.upload).not.toHaveBeenCalled();
    expect(d.createPost).not.toHaveBeenCalled();
  });

  it('a muted member is stopped before anything is encoded', async () => {
    const d = deps();
    vi.mocked(d.assertNotMuted).mockRejectedValueOnce(new Error('muted'));
    const err = await publishReel(input(), d).catch((e: unknown) => e);
    expect((err as ReelPublishError).stage).toBe('moderation');
    expect(d.prepare).not.toHaveBeenCalled();
  });
});

describe('publishCameraPhoto', () => {
  it('uploads the edited photo as an archive post, never as a reel', async () => {
    const createPost = vi.fn(async () => ({ id: 'p-photo' }) as never);
    const upload = vi.fn(async () => ({
      ...ref,
      type: 'image' as const,
      mimeType: 'image/webp',
    }));
    await publishCameraPhoto(
      {
        clip: { blob: new Blob(['photo'], { type: 'image/jpeg' }), source: 'camera' },
        caption: 'a photo',
        identity: '',
      },
      {
        assertNotMuted: vi.fn(async () => {}),
        getToken: vi.fn(async () => 'tok'),
        upload,
        createPost,
      }
    );
    expect(upload).toHaveBeenCalledWith(expect.any(File), 'tok', { width: 640, height: 480 });
    expect(createPost).toHaveBeenCalledWith({
      markdown: 'a photo',
      media: [expect.objectContaining({ type: 'image' })],
    });
  });
});

describe('declaredReelDurationMs', () => {
  it('rounds to whole milliseconds', () => {
    expect(declaredReelDurationMs(41.2504, 90_000)).toBe(41250);
  });

  it('declares the cap for a take inside the grace past it', () => {
    expect(declaredReelDurationMs(90.04, 90_000)).toBe(90_000);
  });

  it('never declares zero', () => {
    expect(declaredReelDurationMs(0.0001, 90_000)).toBe(1);
  });
});

/**
 * A feed reel is uploaded `reel-pending`, never `reel`: the server sweeps a pending upload a day
 * later unless the post's claim promotes it, so a publish that fails after its upload leaves no blob
 * behind for ever (reels audit, 2026-10-11).
 */
describe('defaultPublishReelDeps', () => {
  it('uploads the reel under the reel-pending class, which only the claim promotes', async () => {
    const upload = vi
      .spyOn(MediaService.prototype, 'encryptAndUpload')
      .mockResolvedValue(ref as never);
    const file = new File([new Uint8Array(4)], 'reel.mp4', { type: 'video/mp4' });

    await defaultPublishReelDeps().upload(file, 'token', { width: 9, height: 16 });

    expect(upload).toHaveBeenCalledWith(file, 'token', { width: 9, height: 16 }, 'reel-pending');
    upload.mockRestore();
  });
});
