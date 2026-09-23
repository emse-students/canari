import { getPost, type PostEntity } from '$lib/posts/api';
import { markdownToPlainText, truncateForMeta } from '$lib/seo/text';
import type { SeoMeta } from '$lib/seo/types';
import type { PageLoad } from './$types';
import { redirectIfNotFeedAudience } from '$lib/posts/feedAudience';

export const load: PageLoad = async ({ params }) => {
  // BOTH AT ONCE, NOT ONE THEN THE OTHER. These were two sequential awaits, so opening a post from
  // the feed cost the audience round trip PLUS the post's, back to back, with the reader still
  // looking at the feed. They answer independent questions and neither needs the other's result.
  const fetching = getPost(params.postId).catch(() => null);

  if (await redirectIfNotFeedAudience()) return;

  // A refusal here is not distinguished from an absent post on purpose: the page shows its
  // "not found" state rather than a hard 404, and it has done so since this route existed.
  const post: PostEntity | null = await fetching;
  const seo: SeoMeta | undefined = post
    ? {
        title: 'Publication',
        description: post.markdown?.trim()
          ? truncateForMeta(markdownToPlainText(post.markdown))
          : 'Publication sur le fil social Canari.',
        path: `/posts/${post.id}`,
        ogType: 'article',
      }
    : undefined;

  return { post, seo };
};
