<script lang="ts">
  import { Pin, PinOff, Pencil, Trash2, Flag, Link, Check } from '@lucide/svelte';
  import { copyPublicShareLink } from '$lib/utils/copyShareLink';
  import { slide } from 'svelte/transition';
  import { m } from '$lib/paraglide/messages';

  /**
   * Props for the PostOverlayControls component.
   * Renders the top-right overlay of a post card:
   * - Pin/Unpin: admins only
   * - Edit: post author OR global admin
   * - Delete: post author OR global admin
   * - Report: any logged-in user who is not the post author
   */
  interface Props {
    /** Whether the post is currently pinned. */
    pinned: boolean;
    /** Whether the current user is the post author. */
    isOwnPost: boolean;
    /** Whether the current user is a global admin. */
    isGlobalAdmin: boolean;
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
    /** Called when the author clicks "Edit post". */
    onStartEdit: () => void;
    /** Called when the author clicks "Delete post". */
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
    isOwnPost,
    isGlobalAdmin,
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
    {#if isGlobalAdmin}
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
    {#if isOwnPost || isGlobalAdmin}
      <button
        type="button"
        onclick={onStartEdit}
        class="text-text-muted rounded-lg p-1.5 transition-colors outline-none hover:bg-amber-500/10 hover:text-amber-500"
        aria-label={m.post_edit_post_label()}
      >
        <Pencil size={14} strokeWidth={2.5} />
      </button>
    {/if}
    {#if isOwnPost || isGlobalAdmin}
      <button
        type="button"
        onclick={onDelete}
        class="text-text-muted rounded-lg p-1.5 transition-colors outline-none hover:bg-red-500/10 hover:text-red-500"
        aria-label={m.post_delete_post_label()}
      >
        <Trash2 size={14} strokeWidth={2.5} />
      </button>
    {/if}
    {#if !isOwnPost}
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
