<script lang="ts">
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import AnonymousAvatar from '$lib/components/shared/AnonymousAvatar.svelte';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import { commentAuthorKind } from '$lib/posts/commentAuthor';
  import type { PostComment } from '$lib/posts/api';

  /**
   * THE AVATAR OF WHO WROTE A COMMENT: the association's logo, the anonymous mask, or the person's
   * photo - never a photo drawn from an account an anonymous comment does not carry. One component
   * for the thread and for the card's one-comment preview, so the two cannot disagree about it.
   */
  interface Props {
    comment: PostComment;
    /** Tailwind size of the box, `h-8 w-8` by default. */
    box?: string;
  }

  let { comment, box = 'h-8 w-8' }: Props = $props();

  const kind = $derived(commentAuthorKind(comment));
</script>

{#if kind === 'association' && comment.association}
  <span class="block {box}">
    <AssociationAvatar
      id={comment.association.id}
      fill
      shape="circle"
      name={comment.association.name}
      logoUrl={comment.association.logoUrl}
    />
  </span>
{:else if kind === 'anonymous'}
  <span class="block {box}"><AnonymousAvatar fill /></span>
{:else if comment.userId}
  <span class="block {box}"><Avatar userId={comment.userId} fill /></span>
{/if}
