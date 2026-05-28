import { getPost, type PostEntity } from '$lib/posts/api';
import type { PageLoad } from './$types';
import { fetchMyProfile, isGlobalAdmin } from '$lib/stores/user';
import { goto } from '$app/navigation';

export const load: PageLoad = async ({ params }) => {
  if (!isGlobalAdmin()) {
    try {
      const profile = await fetchMyProfile();
      if (profile.formation !== 'ICM') {
        return goto('/chat', { replaceState: true }).catch(() => {});
      }
    } catch {
      return goto('/chat', { replaceState: true }).catch(() => {});
    }
  }

  let post: PostEntity | null = null;
  try {
    post = await getPost(params.postId);
  } catch {
    // Post doesn't exist or network error - show "not found" UI instead of hard 404
  }
  return { post };
};
