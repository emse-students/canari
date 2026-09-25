<script lang="ts">
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import type { PostEntity } from '$lib/posts/api';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import AnonymousAvatar from '$lib/components/shared/AnonymousAvatar.svelte';
  import { Clock, VenetianMask } from '@lucide/svelte';
  import { timeAgo, exactDate } from '$lib/utils/time';
  import { m } from '$lib/paraglide/messages';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';

  /** Props for the PostHeader component. */
  interface Props {
    /** The post whose author/association and creation time are displayed. */
    post: PostEntity;
  }

  let { post }: Props = $props();

  /**
   * `post.anonymous` alone is not enough to decide the identity branch: a moderator, a platform
   * admin, and the post's own author all receive `authorId` on an anonymous post (server-side,
   * `PostsService.mustHideAnonymousAuthor`) - a user request, 2026-09-17, that these three see the
   * real name/avatar too, not the generic treatment a regular reader gets. Only a regular reader
   * (no `authorId` on the payload) falls into the fully-hidden branch below.
   */
  const identityHidden = $derived(!!post.anonymous && !post.authorId);
  /** True whenever the reader can see WHO published an anonymous post - drives the badge alone. */
  const anonymousBadge = $derived(!!post.anonymous && !!post.authorId);

  /** Returns the display name for the post author: association name for association posts, "Anonyme" when the identity is hidden, "firstName lastName" / displayName / userId otherwise. */
  function getPostAuthorName(): string {
    if (post.association) return post.association.name;
    if (identityHidden) return m.post_anonymous_label();
    const first = post.authorFirstName?.trim();
    const last = post.authorLastName?.trim();
    if (first && last) return `${first} ${last}`;
    if (first) return first;
    if (last) return last;
    if (post.authorDisplayName?.trim()) return post.authorDisplayName.trim();
    return getUserDisplayNameSync(post.authorId ?? '');
  }

  const associationHref = $derived(
    post.association ? `/associations/${encodeURIComponent(post.association.slug)}` : ''
  );
</script>

<!--
  `min-w-0 flex-1` BECAUSE THE ACTION ROW IS THIS HEADER'S SIBLING, NOT ITS OVERLAY.
  `PostCard` lays the two out side by side, so the width left for the name is whatever the buttons
  do not take - which is the only correct answer when the button COUNT varies from one (a reader:
  share) to five (a manager who can also pin, edit, delete and report). Without `min-w-0` a flex
  item refuses to shrink below its content and the `truncate` below never fires.
-->
<div class="flex min-w-0 flex-1 items-center gap-3.5 bg-transparent px-5 py-4">
  {#if post.association}
    <a
      href={associationHref}
      class="shrink-0 rounded-full shadow-sm transition-transform duration-200 outline-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-amber-500"
      aria-label={m.post_view_association_label({ name: post.association.name })}
    >
      <AssociationAvatar
        name={post.association.name}
        logoUrl={post.association.logoUrl}
        size="md"
        shape="circle"
      />
    </a>
  {:else if identityHidden}
    <span class="shrink-0">
      <AnonymousAvatar size="md" shape="circle" />
    </span>
  {:else}
    <a
      href="/profile/{encodeURIComponent(post.authorId ?? '')}"
      class="shrink-0 rounded-full shadow-sm transition-transform duration-200 outline-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-amber-500"
      aria-label={m.post_view_profile_label({ name: getPostAuthorName() })}
    >
      <Avatar userId={post.authorId ?? ''} size="md" />
    </a>
  {/if}

  <div class="flex min-w-0 flex-1 flex-col justify-center">
    <div class="truncate">
      {#if post.association}
        <a
          href={associationHref}
          class="text-text-main text-sm font-bold transition-colors outline-none hover:text-amber-600 focus-visible:underline dark:hover:text-amber-400"
        >
          <EmojiText text={post.association.name} />
        </a>
      {:else if identityHidden}
        <span class="text-text-main text-sm font-bold">{m.post_anonymous_label()}</span>
      {:else}
        <a
          href="/profile/{encodeURIComponent(post.authorId ?? '')}"
          class="text-text-main text-sm font-bold transition-colors outline-none hover:text-amber-600 focus-visible:underline dark:hover:text-amber-400"
        >
          <EmojiText text={getPostAuthorName()} />
        </a>
      {/if}
    </div>
    <div class="text-text-muted text-2xs mt-0.5 flex items-center gap-1.5 font-medium opacity-80">
      <Clock size={12} strokeWidth={2.5} />
      <span title={exactDate(post.createdAt)}>{timeAgo(post.createdAt)}</span>
      {#if anonymousBadge}
        <span class="inline-flex items-center gap-1" title={m.post_anonymous_badge_hint()}>
          <VenetianMask size={12} strokeWidth={2.5} />
          {m.post_anonymous_label()}
        </span>
      {/if}
    </div>
  </div>
</div>
