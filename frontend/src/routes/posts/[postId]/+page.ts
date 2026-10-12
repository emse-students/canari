import { getPost, type PostEntity } from '$lib/posts/api';
import type { SeoMeta } from '$lib/seo/types';
import type { PageLoad } from './$types';
import { redirectIfNotFeedAudience } from '$lib/posts/feedAudience';

export const load: PageLoad = async ({ params }) => {
  // THE POST IS A PROMISE HANDED TO THE PAGE, NOT AWAITED HERE (WP-NAV-1). Awaited, the click on a
  // post in the feed did nothing visible until the GET answered - up to the 20 s read deadline on a
  // weak link - with the reader still looking at the feed. The page now opens at once with its header
  // and a skeleton and fills in when the post arrives. The request still starts before the audience
  // gate, so the two overlap as they did.
  //
  // A refusal is not distinguished from an absent post on purpose: the page shows its "not found"
  // state rather than a hard 404, and it has done so since this route existed.
  const post: Promise<PostEntity | null> = getPost(params.postId).catch(() => null);

  if (await redirectIfNotFeedAudience()) return;

  // The title and path are known without the post. The description used to be cut from its text; this
  // route is `ssr = false` and behind sign-in, so no crawler or link preview ever read it.
  const seo: SeoMeta = {
    title: 'Publication',
    description: 'Publication sur le fil social Canari.',
    path: `/posts/${params.postId}`,
    ogType: 'article',
  };

  return { post, seo };
};
