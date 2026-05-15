import { getPost } from '$lib/posts/api';
import { error } from '@sveltejs/kit';
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

  try {
    const post = await getPost(params.postId);
    return { post };
  } catch {
    error(404, 'Publication introuvable');
  }
};
