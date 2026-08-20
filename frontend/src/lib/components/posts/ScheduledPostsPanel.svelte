<script lang="ts">
  import { Clock, Trash2 } from '@lucide/svelte';
  import type { ScheduledPost } from '$lib/posts/api';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  /**
   * Banner listing the current user's posts that are scheduled for future publication.
   * Each row shows a markdown preview, the scheduled date, and a delete button.
   * Hidden when there are no scheduled posts.
   */
  interface Props {
    /** Posts scheduled for future publication. */
    posts: ScheduledPost[];
    /** Called when the user deletes a scheduled post. Receives the post ID. */
    onDelete: (id: string) => void;
  }

  let { posts, onDelete }: Props = $props();

  /** Formats a UTC ISO string into a short French locale date+time string. */
  function formatScheduled(iso: string): string {
    return new Date(iso).toLocaleString(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  }
</script>

<div class="border-cn-border mb-5 overflow-hidden rounded-2xl border bg-(--cn-surface)/40">
  <!-- Panel header -->
  <div class="border-cn-border flex items-center gap-2 border-b bg-amber-500/5 px-4 py-2.5">
    <Clock size={14} class="shrink-0 text-amber-500" />
    <span class="text-xs font-bold tracking-wider text-amber-600 uppercase dark:text-amber-400">
      {m.post_scheduled_panel_title({ count: posts.length })}
    </span>
  </div>

  <ul class="divide-cn-border divide-y">
    {#each posts as sp (sp.id)}
      <li class="flex items-center gap-3 px-4 py-3">
        <!-- Markdown preview (truncated) -->
        <div class="min-w-0 flex-1">
          <p class="text-text-main truncate text-sm">
            {sp.markdown.slice(0, 80)}{sp.markdown.length > 80 ? '…' : ''}
          </p>
          <p class="text-text-muted mt-0.5 text-xs">
            {m.post_scheduled_published_on_label({ date: formatScheduled(sp.scheduledAt) })}
          </p>
        </div>

        <button
          type="button"
          onclick={() => onDelete(sp.id)}
          class="text-text-muted shrink-0 rounded-lg p-1.5 transition-colors hover:bg-red-500/10 hover:text-red-500"
          title={m.common_delete_button()}
          aria-label={m.common_delete_button()}
        >
          <Trash2 size={15} />
        </button>
      </li>
    {/each}
  </ul>
</div>
