/**
 * A COMMENT UPLOAD ASKS FOR A LIVE TOKEN, NOT THE COPY THE PAGE WAS GIVEN AT SIGN-IN.
 *
 * The `authToken` prop is a display copy taken once; its 15 min life is over by the time a member
 * pastes an image, and the upload then failed with `401 JWT expired`. The one place that knows the
 * expiry is `getToken()`, so the upload reads it there. The control is the stale prop itself: it is
 * passed as `'stale-token'` and must never reach the media service.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const encryptAndUpload = vi.fn(async (_file: File, _token: string) => ({
  type: 'image',
  mediaId: 'm1',
}));
vi.mock('$lib/media', () => ({
  MediaService: class {
    encryptAndUpload = encryptAndUpload;
  },
  compressImage: vi.fn(),
  IMAGE_COMPRESS_PRESETS: { comment: { maxWidth: 1, maxHeight: 1, quality: 1 } },
}));
vi.mock('$lib/stores/auth', () => ({ getToken: vi.fn(async () => 'fresh-token') }));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `User ${id}`,
  resolveUserDisplayName: async (id: string) => `User ${id}`,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));

import PostComments from './PostComments.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  encryptAndUpload.mockClear();
});

it('uploads comment media with getToken(), never with the stale authToken prop', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:x');
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(PostComments, {
    target,
    props: {
      comments: [],
      topLevelComments: [],
      showComments: true,
      commentText: '',
      submittingComment: false,
      currentUserId: 'u1',
      authToken: 'stale-token',
      onToggleComments: vi.fn(),
      onCommentTextChange: vi.fn(async () => {}),
      onAddComment: vi.fn(async () => {}),
      onLikeComment: vi.fn(),
      onEditComment: vi.fn(async () => {}),
      onDeleteComment: vi.fn(async () => {}),
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();

  const editor = target.querySelector('.mention-composer-editor') as HTMLElement;
  expect(editor).not.toBeNull();
  const file = new File([new Uint8Array([1])], 'a.gif', { type: 'image/gif' });
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { items: [{ kind: 'file', getAsFile: () => file }], files: [file], getData: () => '' },
  });
  editor.dispatchEvent(event);
  await vi.waitFor(() => expect(encryptAndUpload).toHaveBeenCalledTimes(1));

  expect(encryptAndUpload.mock.calls[0][1]).toBe('fresh-token');
});
