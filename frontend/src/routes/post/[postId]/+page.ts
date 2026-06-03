import { redirect } from '@sveltejs/kit';

/** Legacy share URLs used `/post/{id}` — keep a permanent redirect to `/posts/{id}`. */
export function load({ params }: { params: { postId: string } }) {
  redirect(301, `/posts/${params.postId}`);
}
