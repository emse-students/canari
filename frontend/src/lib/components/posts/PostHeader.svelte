<script lang="ts">
  import type { PostEntity } from '$lib/posts/api';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import { Clock } from '@lucide/svelte';
  import { timeAgo, exactDate } from '$lib/utils/time';
  import { m } from '$lib/paraglide/messages';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';

  /** Props for the PostHeader component. */
  interface Props {
    /** The post whose author/association and creation time are displayed. */
    post: PostEntity;
  }

  let { post }: Props = $props();

  /** Returns the display name for the post author: association name for association posts, "firstName lastName" / displayName / userId for personal posts. */
  function getPostAuthorName(): string {
    if (post.association) return post.association.name;
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

<div class="flex items-center gap-3.5 bg-transparent px-5 py-4">
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
          class="text-text-main text-[0.95rem] font-bold transition-colors outline-none hover:text-amber-600 focus-visible:underline dark:hover:text-amber-400"
        >
          {post.association.name}
        </a>
      {:else}
        <a
          href="/profile/{encodeURIComponent(post.authorId ?? '')}"
          class="text-text-main text-[0.95rem] font-bold transition-colors outline-none hover:text-amber-600 focus-visible:underline dark:hover:text-amber-400"
        >
          {getPostAuthorName()}
        </a>
      {/if}
    </div>
    <div
      class="text-text-muted mt-0.5 flex items-center gap-1.5 text-[0.75rem] font-medium opacity-80"
    >
      <Clock size={12} strokeWidth={2.5} />
      <span title={exactDate(post.createdAt)}>{timeAgo(post.createdAt)}</span>
    </div>
  </div>
</div>
