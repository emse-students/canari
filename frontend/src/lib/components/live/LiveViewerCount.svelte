<script lang="ts">
  /**
   * HOW MANY WATCH A LIVE: an eye and a number, on the viewer's screen and the broadcaster's (the
   * owner's decision of 2026-10-21, "like Instagram"). A COUNT AND NOTHING ELSE - the server sends
   * no viewer's identity to anybody (docs/wiki/frontend/modules/live.md, "The viewer count").
   *
   * Draws nothing while the count is unknown (`null`: before the first poll, or a count the server
   * could not read), never a placeholder number. The number is visual; a screen reader reads the
   * plural sentence instead, and is not told every change (`aria-live="off"`, which also mutes it
   * inside the broadcaster's `role="status"` row: the count moves with every arrival, and
   * announcing each one would bury the chat).
   */
  import { Eye } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    count: number | null;
  }

  let { count }: Props = $props();
</script>

{#if count !== null}
  <span
    class="bg-cn-scrim/40 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums"
    aria-live="off"
    data-live-viewer-count={count}
  >
    <Eye size={14} strokeWidth={2.5} aria-hidden="true" />
    <span aria-hidden="true">{count}</span>
    <span class="sr-only">{m.live_viewer_count({ count })}</span>
  </span>
{/if}
