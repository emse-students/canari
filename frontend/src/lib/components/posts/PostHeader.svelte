<script lang="ts">
  import type { PostEntity } from '$lib/posts/api';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import { Clock } from 'lucide-svelte';

  interface Props {
    post: PostEntity;
  }

  let { post }: Props = $props();

  function getPostAuthorName(): string {
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
    return post.authorId;
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
</script>

<div class="flex items-center gap-3.5 px-5 py-4 bg-transparent">
  <!-- Avatar cliquable -->
  <a
    href="/profile/{encodeURIComponent(post.authorId)}"
    class="shrink-0 transition-transform duration-200 hover:scale-105 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-full shadow-sm"
    aria-label="Voir le profil de {getPostAuthorName()}"
  >
    <Avatar userId={post.authorId} size="md" />
  </a>

  <!-- Informations de l'auteur et date -->
  <div class="flex-1 min-w-0 flex flex-col justify-center">
    <div class="truncate">
      <a
        href="/profile/{encodeURIComponent(post.authorId)}"
        class="font-bold text-[0.95rem] text-text-main hover:text-amber-600 dark:hover:text-amber-400 transition-colors outline-none focus-visible:underline"
      >
        {getPostAuthorName()}
      </a>
    </div>
    <div class="text-[0.75rem] font-medium text-text-muted flex items-center gap-1.5 mt-0.5 opacity-80">
      <Clock size={12} strokeWidth={2.5} />
      {timeAgo(post.createdAt)}
    </div>
  </div>
</div>
