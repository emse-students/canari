<script lang="ts">
  /**
   * THE PICTURE A POST IS PUBLISHED UNDER - the association's logo, the generic anonymous face for an
   * anonymous post (even for the reader who is served its author: the post is drawn as published,
   * the author is the small line under "Anonyme" - `RevealedAuthorLine`), or the author's avatar. ONE choice, drawn by the post
   * header and by the reel viewer's overlay, so the two never show a different publisher. The link
   * around it is the caller's (`postAuthorHref`).
   */
  import type { PostEntity } from '$lib/posts/api';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import AnonymousAvatar from '$lib/components/shared/AnonymousAvatar.svelte';

  interface Props {
    post: Pick<PostEntity, 'association' | 'anonymous' | 'authorId'>;
    size?: 'sm' | 'md';
  }

  let { post, size = 'md' }: Props = $props();
</script>

{#if post.association}
  <AssociationAvatar
    name={post.association.name}
    logoUrl={post.association.logoUrl}
    {size}
    shape="circle"
  />
{:else if post.anonymous}
  <AnonymousAvatar {size} shape="circle" />
{:else}
  <Avatar userId={post.authorId ?? ''} {size} />
{/if}
