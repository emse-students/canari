// @vitest-environment happy-dom
/**
 * REPLYING WITH AN IMPORTED IMAGE (owner, 2026-11-09: "comme un gif, mais importe"). The image
 * button picks ONE image from the library and feeds the SAME staging path as a paste or a GIF:
 * compressed like a post photo, encrypted and uploaded BEFORE the comment can be sent, the ref
 * handed to `onSubmit`, a failure said with a retry that needs no second pick.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import CommentComposer from './CommentComposer.svelte';
import type { CommentOutcome } from '$lib/posts/postCommentThread.svelte';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

const env = vi.hoisted(() => ({
  encryptAndUpload: vi.fn(),
  compressImage: vi.fn(),
  readImageDimensions: vi.fn(),
}));

vi.mock('$lib/media', () => ({
  MediaService: class {
    encryptAndUpload = env.encryptAndUpload;
  },
  compressImage: env.compressImage,
  readImageDimensions: env.readImageDimensions,
  IMAGE_COMPRESS_PRESETS: { comment: { maxWidth: 1280, maxHeight: 1280, quality: 0.9 } },
}));
vi.mock('$lib/stores/auth', () => ({ getToken: vi.fn(async () => 'fresh-token') }));
vi.mock('$lib/stores/user', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/user')>()),
  getSavedUserId: () => 'u1',
  getSavedDisplayName: () => 'Ada Lovelace',
  isGlobalAdmin: () => false,
}));
vi.mock('$lib/associations/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/associations/api')>()),
  listMyAssociations: vi.fn().mockResolvedValue([]),
  listAssociations: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `User ${id}`,
  resolveUserDisplayName: async (id: string) => `User ${id}`,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplay: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplay: () => {},
}));

const mounted: (() => void)[] = [];
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  env.encryptAndUpload.mockReset();
  env.compressImage.mockReset();
  env.compressImage.mockImplementation(async (file: File) => ({ file, width: 800, height: 600 }));
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mountComposer() {
  const onSubmit = vi.fn(async (_send: unknown) => 'sent' as CommentOutcome);
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(CommentComposer, {
    target,
    props: {
      postId: 'p1',
      value: '',
      onChange: vi.fn(),
      placeholder: 'Write',
      submitting: false,
      currentUserId: 'u1',
      replyTo: null,
      onCancelReply: vi.fn(),
      onSubmit,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return { target, onSubmit };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    flushSync();
  }
  await tick();
};
const sendButton = (t: HTMLElement) =>
  t.querySelector<HTMLButtonElement>(`button[aria-label="${m.post_send_comment_label()}"]`)!;
const pick = async (t: HTMLElement, file: File) => {
  const input = t.querySelector<HTMLInputElement>('[data-testid="comment-image-input"]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
};
const photo = () => new File([new Uint8Array([1, 2, 3])], 'p.jpg', { type: 'image/jpeg' });
const REF = {
  type: 'image',
  mediaId: 'm1',
  key: 'k',
  iv: 'i',
  mimeType: 'image/jpeg',
  size: 3,
  width: 800,
  height: 600,
};

describe('the image button', () => {
  it('sits beside the GIF button, labelled, and opens an image-only input', () => {
    const { target } = mountComposer();
    const button = target.querySelector<HTMLButtonElement>('[data-testid="comment-image-button"]')!;
    expect(button.getAttribute('aria-label')).toBe(m.post_comment_add_image_label());
    expect(target.querySelector(`button[aria-label="${m.chat_send_gif_label()}"]`)).not.toBeNull();
    expect(
      target.querySelector<HTMLInputElement>('[data-testid="comment-image-input"]')!.accept
    ).toBe('image/*');
  });

  it('compresses, encrypts and uploads the pick, then sends its ref (without `type`) on submit', async () => {
    env.encryptAndUpload.mockResolvedValue(REF);
    const { target, onSubmit } = mountComposer();
    expect(sendButton(target).disabled).toBe(true);

    await pick(target, photo());

    expect(env.compressImage).toHaveBeenCalledOnce();
    expect(env.encryptAndUpload).toHaveBeenCalledWith(
      expect.any(File),
      'fresh-token',
      { width: 800, height: 600 },
      'archive'
    );
    expect(sendButton(target).disabled).toBe(false);
    sendButton(target).click();
    await settle();
    const sent = onSubmit.mock.calls[0][0] as { media?: Record<string, unknown> };
    expect(sent.media).toMatchObject({ mediaId: 'm1', mimeType: 'image/jpeg' });
    expect(sent.media).not.toHaveProperty('type');
  });

  it('cannot send while the upload is still going', async () => {
    let finish!: (v: unknown) => void;
    env.encryptAndUpload.mockReturnValue(new Promise((r) => (finish = r)));
    const { target } = mountComposer();
    await pick(target, photo());
    expect(sendButton(target).disabled).toBe(true);
    finish(REF);
    await settle();
    expect(sendButton(target).disabled).toBe(false);
  });

  it('keeps a GIF as it is: no canvas compression', async () => {
    env.encryptAndUpload.mockResolvedValue({ ...REF, mimeType: 'image/gif' });
    const { target } = mountComposer();
    await pick(target, new File([new Uint8Array([1])], 'a.gif', { type: 'image/gif' }));
    expect(env.compressImage).not.toHaveBeenCalled();
    expect(env.encryptAndUpload).toHaveBeenCalledOnce();
  });

  it('sends a GIF with its own size, so the comment draws it uncropped', async () => {
    env.readImageDimensions.mockResolvedValue({ width: 480, height: 270 });
    env.encryptAndUpload.mockResolvedValue({ ...REF, mimeType: 'image/gif' });
    const { target } = mountComposer();
    await pick(target, new File([new Uint8Array([1])], 'a.gif', { type: 'image/gif' }));
    expect(env.encryptAndUpload.mock.calls[0][2]).toEqual({ width: 480, height: 270 });
  });

  it('refuses a file that is not an image, and uploads nothing', async () => {
    const { target } = mountComposer();
    await pick(target, new File([new Uint8Array([1])], 'v.mp4', { type: 'video/mp4' }));
    expect(env.encryptAndUpload).not.toHaveBeenCalled();
    expect(sendButton(target).disabled).toBe(true);
  });

  it('says a failed upload with a retry that re-sends the SAME file, then attaches it', async () => {
    env.encryptAndUpload.mockRejectedValueOnce(new TypeError('network')).mockResolvedValue(REF);
    const { target } = mountComposer();
    await pick(target, photo());

    expect(target.querySelector('[data-testid="comment-media-failed"]')).not.toBeNull();
    expect(sendButton(target).disabled).toBe(true);

    target.querySelector<HTMLButtonElement>('[data-testid="comment-media-retry"]')!.click();
    await settle();

    expect(env.encryptAndUpload).toHaveBeenCalledTimes(2);
    expect(target.querySelector('[data-testid="comment-media-failed"]')).toBeNull();
    expect(sendButton(target).disabled).toBe(false);
  });
});
