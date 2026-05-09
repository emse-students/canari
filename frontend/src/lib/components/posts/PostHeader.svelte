<script lang="ts">
  import type { PostEntity } from '$lib/posts/api';
  import { associationLogoSrc } from '$lib/associations/api';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import { getInitials } from '$lib/utils/avatar';
  import { Clock } from 'lucide-svelte';

  interface Props {
    post: PostEntity;
  }

  let { post }: Props = $props();

  function getPostAuthorName(): string {
    if (post.association) {
      return post.association.name;
    }
    const first = post.authorFirstName?.trim();
    const last = post.authorLastName?.trim();

    if (first && last) {
      return `${first} ${last}`;
    }
    if (first) {
      return first;
    }
    if (last) {
      return last;
    }
    if (post.authorDisplayName?.trim()) {
      return post.authorDisplayName.trim();
    }
    return post.authorId ?? '';
  }

  function timeAgo(dateStr: string): string {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diffSec = Math.floor((now - then) / 1000);
    if (diffSec < 60) return 'À l\u2019instant';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `Il y a ${diffMin} min`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `Il y a ${diffH} h`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `Il y a ${diffD} j`;
    return new Date(dateStr).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
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
      aria-label="Voir l'association {post.association.name}"
    >
      {#if associationLogoSrc(post.association.logoUrl)}
        <img
          src={associationLogoSrc(post.association.logoUrl)}
          alt=""
          class="w-9 h-9 rounded-full object-cover border border-cn-border/60 bg-[var(--cn-surface)]"
        />
      {:else}
        <div
          class="w-9 h-9 rounded-full bg-amber-500/15 border border-amber-500/25 flex items-center justify-center text-[0.7rem] font-bold text-amber-800 dark:text-amber-200"
        >
          {getInitials(post.association.name)}
        </div>
      {/if}
    </a>
  {:else}
    <a
      href="/profile/{encodeURIComponent(post.authorId ?? '')}"
      class="shrink-0 transition-transform duration-200 hover:scale-105 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-full shadow-sm"
      aria-label="Voir le profil de {getPostAuthorName()}"
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
    <div class="text-[0.75rem] font-medium text-text-muted flex items-center gap-1.5 mt-0.5 opacity-80">
      <Clock size={12} strokeWidth={2.5} />
      {timeAgo(post.createdAt)}
    </div>
  </div>
</div>
