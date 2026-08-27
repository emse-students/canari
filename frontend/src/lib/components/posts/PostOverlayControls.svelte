<script lang="ts">
  import { Pin, PinOff, Pencil, Trash2, Flag, Link, Check } from '@lucide/svelte';
  import { copyPublicShareLink } from '$lib/utils/copyShareLink';
  import { slide } from 'svelte/transition';
  import { m } from '$lib/paraglide/messages';

  /**
   * Props for the PostOverlayControls component.
   * Renders the top-right overlay of a post card: share, pin, edit, delete, report.
   *
   * Every gate below is a boolean the SERVER answered for this reader (`canManage`, `canPin`,
   * `canReport`); nothing here is derived from the post's contents. A card cannot tell its own
   * association's posts from anyone else's - their author is stripped on purpose - nor whether its
   * reader moderates the feed.
   */
  interface Props {
    /** Whether the post is currently pinned. */
    pinned: boolean;
    /**
     * May edit or delete: the post's publisher (its author, or an officer of the association it
     * speaks for), a content moderator, or a platform admin.
     */
    canManage: boolean;
    /** May pin or unpin: a content moderator (BDE MODERATE) or a platform admin. */
    canPin: boolean;
    /** May report: any logged-in reader who is not the post's own publisher. */
    canReport: boolean;
    /** Whether any user is logged in (gates the report button). */
    isLoggedIn: boolean;
    /** Whether the report popover is currently open. */
    reportOpen: boolean;
    /** The currently selected report reason. */
    reportReason: string;
    /** Whether the report submission is in progress. */
    reportSubmitting: boolean;
    /** Available report reason strings. */
    reportReasons: string[];
    /** Called when the admin clicks pin/unpin. */
    onTogglePin: () => void;
    /** Called when a manager clicks "Edit post". */
    onStartEdit: () => void;
    /** Called when a manager clicks "Delete post". */
    onDelete: () => void;
    /** Called to open or close the report popover. */
    onToggleReport: (open: boolean) => void;
    /** Called when the user changes the selected report reason. */
    onReportReasonChange: (reason: string) => void;
    /** Called when the user submits the report. */
    onSubmitReport: () => void;
    /** Post id used for the public share link. */
    postId: string;
  }

  let {
    pinned,
    canManage,
    canPin,
    canReport,
    isLoggedIn,
    reportOpen,
    reportReason,
    reportSubmitting,
    reportReasons,
    onTogglePin,
    onStartEdit,
    onDelete,
    onToggleReport,
    onReportReasonChange,
    onSubmitReport,
    postId,
  }: Props = $props();

  let copiedLink = $state(false);

  function sharePost() {
    void copyPublicShareLink(`/posts/${postId}`);
    copiedLink = true;
    setTimeout(() => (copiedLink = false), 2000);
  }
</script>

{#if isLoggedIn}
  <div class="absolute top-3 right-3 flex items-center gap-1">
    <button
      type="button"
      onclick={sharePost}
      class="text-text-muted rounded-lg p-1.5 transition-colors outline-none hover:bg-amber-500/10 hover:text-amber-600"
      aria-label={copiedLink ? m.post_link_copied_label() : m.post_share_post_label()}
      title={copiedLink ? m.post_link_copied_label() : m.post_share_label()}
    >
      {#if copiedLink}
        <Check size={14} strokeWidth={2.5} />
      {:else}
        <Link size={14} strokeWidth={2.5} />
      {/if}
    </button>
    {#if canPin}
      <button
        type="button"
        onclick={onTogglePin}
        class="text-text-muted rounded-lg p-1.5 transition-colors outline-none hover:bg-amber-500/10 hover:text-amber-500"
        aria-label={pinned ? m.post_unpin_action_label() : m.post_pin_action_label()}
        title={pinned ? m.post_unpin_action_label() : m.post_pin_action_label()}
      >
        {#if pinned}
          <PinOff size={14} strokeWidth={2.5} />
        {:else}
          <Pin size={14} strokeWidth={2.5} />
        {/if}
      </button>
    {/if}
    {#if canManage}
      <button
        type="button"
        onclick={onStartEdit}
        class="text-text-muted rounded-lg p-1.5 transition-colors outline-none hover:bg-amber-500/10 hover:text-amber-500"
        aria-label={m.post_edit_post_label()}
      >
        <Pencil size={14} strokeWidth={2.5} />
      </button>
    {/if}
    {#if canManage}
      <button
        type="button"
        onclick={onDelete}
        class="text-text-muted rounded-lg p-1.5 transition-colors outline-none hover:bg-red-500/10 hover:text-red-500"
        aria-label={m.post_delete_post_label()}
      >
        <Trash2 size={14} strokeWidth={2.5} />
      </button>
    {/if}
    {#if canReport}
      {#if reportOpen}
        <div
          class="bg-surface-elevated border-cn-border absolute top-0 right-0 z-50 flex w-52 flex-col gap-2 rounded-xl border p-3 shadow-lg"
          transition:slide={{ duration: 150 }}
        >
          <p class="text-text-muted text-[0.65rem] font-bold tracking-wide uppercase">
            {m.post_report_post_title()}
          </p>
          <div class="flex flex-col gap-1">
            {#each reportReasons as r (r)}
              <label
                class="hover:text-text-main flex cursor-pointer items-center gap-2 text-sm transition-colors"
              >
                <input
                  type="radio"
                  checked={reportReason === r}
                  onchange={() => onReportReasonChange(r)}
                  class="shrink-0 accent-amber-500"
                />
                <span class="text-[0.82rem]">{r}</span>
              </label>
            {/each}
          </div>
          <div class="mt-1 flex gap-2">
            <button
              type="button"
              onclick={() => onToggleReport(false)}
              class="text-text-muted hover:text-text-main flex-1 rounded-lg py-1.5 text-xs font-bold transition-colors"
              >{m.common_cancel_button()}</button
            >
            <button
              type="button"
              onclick={onSubmitReport}
              disabled={!reportReason || reportSubmitting}
              class="flex-1 rounded-lg bg-red-500 py-1.5 text-xs font-bold text-white transition-colors hover:bg-red-400 disabled:opacity-40"
              >{m.post_report_label()}</button
            >
          </div>
        </div>
      {:else}
        <button
          type="button"
          onclick={() => onToggleReport(true)}
          class="text-text-muted rounded-lg p-1.5 transition-colors outline-none hover:bg-red-500/10 hover:text-red-500"
          aria-label={m.post_report_post_title()}
        >
          <Flag size={14} strokeWidth={2.5} />
        </button>
      {/if}
    {/if}
  </div>
{/if}
