import { listPosts } from '$lib/posts/api';
import type { PageLoad } from './$types';

// Return the Promise without awaiting it so SvelteKit renders the page
// immediately with a skeleton while the data loads in the background.
export const load: PageLoad = () => ({
  posts: listPosts(20),
});
