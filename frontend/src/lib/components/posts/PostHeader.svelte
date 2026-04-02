<script lang="ts">
  import type { PostEntity } from '$lib/posts/api';

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

  function getAuthorInitials(): string {
    const first = post.authorFirstName?.trim().charAt(0)?.toUpperCase() || '';
    const last = post.authorLastName?.trim().charAt(0)?.toUpperCase() || '';
    
    if (first && last) {
      return first + last;
    }
    if (first) {
      return first;
    }
    if (last) {
      return last;
    }
    
    const display = (post.authorDisplayName?.trim() || post.authorId).charAt(0).toUpperCase();
    return display;
  }

  function timeAgo(dateStr: string): string {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diffSec = Math.floor((now - then) / 1000);
    if (diffSec < 60) return 'à l\u2019instant';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `il y a ${diffMin} min`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `il y a ${diffH}h`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `il y a ${diffD}j`;
    return new Date(dateStr).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }
</script>

<div class="flex items-center gap-3 px-5 py-4">
  <div
    class="w-10 h-10 rounded-full bg-gradient-to-br from-cn-yellow/30 to-cn-yellow/10 flex items-center justify-center text-cn-dark font-bold text-sm border border-cn-border/50"
  >
    {getAuthorInitials()}
  </div>
  <div class="flex-1 min-w-0">
    <div class="font-bold text-sm text-text-main truncate">
      {getPostAuthorName()}
    </div>
    <div class="text-xs text-text-muted">{timeAgo(post.createdAt)}</div>
  </div>
</div>
