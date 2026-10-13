import { describe, it, expect, vi, beforeEach } from 'vitest';

const showConfirm = vi.hoisted(() => vi.fn());
const deletePost = vi.hoisted(() => vi.fn());
vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm }));
vi.mock('./api', () => ({ deletePost }));

import { deletePostAfterConfirm } from './postDeletion';
import { m } from '$lib/paraglide/messages';

beforeEach(() => {
  showConfirm.mockReset();
  deletePost.mockReset();
});

describe('deletePostAfterConfirm - a post is deleted only once its author confirms', () => {
  it('asks, as a destructive action, before any request', async () => {
    showConfirm.mockResolvedValueOnce(true);
    deletePost.mockResolvedValueOnce({ ok: true });

    await expect(deletePostAfterConfirm('p-1')).resolves.toBe('deleted');

    expect(showConfirm).toHaveBeenCalledWith(
      m.post_delete_confirm(),
      expect.objectContaining({ confirmLabel: m.common_delete_button(), danger: true })
    );
    expect(deletePost).toHaveBeenCalledWith('p-1');
    expect(showConfirm.mock.invocationCallOrder[0]).toBeLessThan(
      deletePost.mock.invocationCallOrder[0]
    );
  });

  it('sends nothing when the author keeps the post', async () => {
    showConfirm.mockResolvedValueOnce(false);

    await expect(deletePostAfterConfirm('p-1')).resolves.toBe('declined');

    expect(deletePost).not.toHaveBeenCalled();
  });

  it('rejects when the request fails, so the caller can say so', async () => {
    showConfirm.mockResolvedValueOnce(true);
    deletePost.mockRejectedValueOnce(new Error('503'));

    await expect(deletePostAfterConfirm('p-1')).rejects.toThrow('503');
  });
});
