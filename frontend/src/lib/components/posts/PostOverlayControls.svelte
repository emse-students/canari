<script lang="ts">
  import { Pin, PinOff, Pencil, Trash2, Flag } from 'lucide-svelte';
  import { slide } from 'svelte/transition';

  /**
   * Props for the PostOverlayControls component.
   * Renders the top-right overlay of a post card: pin/unpin (admin), edit/delete (own post),
   * and report (other user's post).
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
  }: Props = $props();
</script>

{#if isOwnPost || isGlobalAdmin}
  <div class="absolute top-3 right-3 flex items-center gap-1">
    {#if isGlobalAdmin}
      <button
        type="button"
        onclick={onTogglePin}
        class="p-1.5 rounded-lg text-text-muted hover:text-amber-500 hover:bg-amber-500/10 transition-colors outline-none"
        aria-label={pinned ? 'Désépingler' : 'Épingler'}
        title={pinned ? 'Désépingler' : 'Épingler'}
      >
        {#if pinned}
          <PinOff size={14} strokeWidth={2.5} />
        {:else}
          <Pin size={14} strokeWidth={2.5} />
        {/if}
      </button>
    {/if}
    {#if isOwnPost}
      <button
        type="button"
        onclick={onStartEdit}
        class="p-1.5 rounded-lg text-text-muted hover:text-amber-500 hover:bg-amber-500/10 transition-colors outline-none"
        aria-label="Modifier le post"
      >
        <Pencil size={14} strokeWidth={2.5} />
      </button>
      <button
        type="button"
        onclick={onDelete}
        class="p-1.5 rounded-lg text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors outline-none"
        aria-label="Supprimer le post"
      >
        <Trash2 size={14} strokeWidth={2.5} />
      </button>
    {/if}
  </div>
{:else if isLoggedIn}
  <div class="absolute top-3 right-3">
    {#if reportOpen}
      <div
        class="flex flex-col gap-2 bg-white dark:bg-[#1a2236] border border-cn-border rounded-xl p-3 shadow-lg w-52 z-20"
        transition:slide={{ duration: 150 }}
      >
        <p class="text-[0.65rem] font-bold text-text-muted uppercase tracking-wide">
          Signaler ce post
        </p>
        <div class="flex flex-col gap-1">
          {#each reportReasons as r (r)}
            <label
              class="flex items-center gap-2 text-sm cursor-pointer hover:text-text-main transition-colors"
            >
              <input
                type="radio"
                checked={reportReason === r}
                onchange={() => onReportReasonChange(r)}
                class="accent-amber-500 shrink-0"
              />
              <span class="text-[0.82rem]">{r}</span>
            </label>
          {/each}
        </div>
        <div class="flex gap-2 mt-1">
          <button
            type="button"
            onclick={() => onToggleReport(false)}
            class="flex-1 text-xs font-bold text-text-muted hover:text-text-main rounded-lg py-1.5 transition-colors"
            >Annuler</button
          >
          <button
            type="button"
            onclick={onSubmitReport}
            disabled={!reportReason || reportSubmitting}
            class="flex-1 text-xs font-bold bg-red-500 text-white rounded-lg py-1.5 disabled:opacity-40 transition-colors hover:bg-red-400"
            >Signaler</button
          >
        </div>
      </div>
    {:else}
      <button
        type="button"
        onclick={() => onToggleReport(true)}
        class="p-1.5 rounded-lg text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors outline-none opacity-0 group-hover/card:opacity-100"
        aria-label="Signaler ce post"
      >
        <Flag size={14} strokeWidth={2.5} />
      </button>
    {/if}
  </div>
{/if}
