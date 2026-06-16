<script lang="ts">
  import type { PostEntity } from '$lib/posts/api';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import { Clock } from '@lucide/svelte';
  import { timeAgo, exactDate } from '$lib/utils/time';
  import { m } from '$lib/paraglide/messages';

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
    return post.authorId ?? '';
  }

  const associationHref = $derived(
    post.association ? `/associations/${encodeURIComponent(post.association.slug)}` : ''
  );
</script>

<div class="flex items-center gap-3.5 px-5 py-4 bg-transparent">
  {#if post.association}
    <a
      href={associationHref}
      class="shrink-0 transition-transform duration-200 hover:scale-105 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-full shadow-sm"
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
      class="shrink-0 transition-transform duration-200 hover:scale-105 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-full shadow-sm"
      aria-label={m.post_view_profile_label({ name: getPostAuthorName() })}
    >
      <Avatar userId={post.authorId ?? ''} size="md" />
    </a>
  {/if}

  <div class="flex-1 min-w-0 flex flex-col justify-center">
    <div class="truncate">
      {#if post.association}
        <a
          href={associationHref}
          class="font-bold text-[0.95rem] text-text-main hover:text-amber-600 dark:hover:text-amber-400 transition-colors outline-none focus-visible:underline"
        >
          {post.association.name}
        </a>
      {:else}
        <a
          href="/profile/{encodeURIComponent(post.authorId ?? '')}"
          class="font-bold text-[0.95rem] text-text-main hover:text-amber-600 dark:hover:text-amber-400 transition-colors outline-none focus-visible:underline"
        >
          {getPostAuthorName()}
        </a>
      {/if}
    </div>
    <div
      class="text-[0.75rem] font-medium text-text-muted flex items-center gap-1.5 mt-0.5 opacity-80"
    >
      <Clock size={12} strokeWidth={2.5} />
      <span title={exactDate(post.createdAt)}>{timeAgo(post.createdAt)}</span>
    </div>
  </div>
</div>
