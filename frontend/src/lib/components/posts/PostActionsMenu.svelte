<script lang="ts">
  import { Pin, PinOff, Pencil, Trash2, Flag, Link, Check, Ellipsis } from '@lucide/svelte';
  import { copyPublicShareLink } from '$lib/utils/copyShareLink';
  import { clickOutside } from '$lib/actions/clickOutside';
  import { slide } from 'svelte/transition';
  import { m } from '$lib/paraglide/messages';

  /**
   * Props for the PostActionsMenu component.
   * Renders the ONE control a post header carries: an overflow button opening share, pin, edit,
   * delete and report.
   *
   * ## Why one button and not five
   *
   * This was five icon buttons drawn straight into the header, and both arrangements of that were
   * wrong. Absolutely positioned over the header they covered the association's name - measured on
   * A1 (Mi 9T, 436 x 945 CSS px) on 2026-09-14, the share icon sat inside "BDE - Bureau des Eleves".
   * Laid out beside it instead, they took 248 px of a 403 px card and cut the same name to
   * "BDE - Bu...". No width splits five 44 px touch targets and a readable name on a phone, so the
   * count is what had to change.
   *
   * Facebook's feed, read on this phone the same day, carries exactly two: an overflow `...` and a
   * dismiss. Everything else is in the sheet the first one opens - and its page names truncate too,
   * which is the point: truncation is not the defect, truncating to eight characters is.
   *
   * ## Why the report popover is gone
   *
   * It was a second implementation of `ReportReasonDialog`, which this card already mounts for
   * comments - four radio buttons and a submit, written twice, one of them 52 px wide on a phone.
   * `onReport` now opens the shared dialog and this component holds no report state at all.
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
    /** Whether any user is logged in (gates the whole menu). */
    isLoggedIn: boolean;
    /** Called when the reader picks pin/unpin. */
    onTogglePin: () => void;
    /** Called when a manager picks "Edit post". */
    onStartEdit: () => void;
    /** Called when a manager picks "Delete post". */
    onDelete: () => void;
    /** Called when the reader picks "Report": the card opens the shared reason dialog. */
    onReport: () => void;
    /** Post id used for the public share link. */
    postId: string;
  }

  let {
    pinned,
    canManage,
    canPin,
    canReport,
    isLoggedIn,
    onTogglePin,
    onStartEdit,
    onDelete,
    onReport,
    postId,
  }: Props = $props();

  let open = $state(false);
  let copiedLink = $state(false);

  /** Runs a menu entry and closes the menu, which every entry does. */
  function pick(action: () => void) {
    open = false;
    action();
  }

  function sharePost() {
    void copyPublicShareLink(`/posts/${postId}`);
    copiedLink = true;
    setTimeout(() => (copiedLink = false), 2000);
  }

  /** One row per action: same box, same padding, so the menu reads as a list rather than a pile. */
  const ROW =
    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors';
</script>

{#if isLoggedIn}
  <!--
    `relative` ONLY to anchor the panel, and `shrink-0` because `PostHeader` is the flex item that
    gives: the name takes whatever this row leaves, which is now one button wide at every width.
    The padding reproduces the offsets the old `absolute top-3 right-3` gave, so the control has not
    moved - it is the four beside it that are gone.
  -->
  <div
    class="relative flex shrink-0 items-center pt-3 pr-3"
    use:clickOutside={() => (open = false)}
  >
    <button
      type="button"
      onclick={() => (open = !open)}
      aria-expanded={open}
      aria-haspopup="menu"
      class="ui-icon-button text-text-muted rounded-lg transition-colors outline-none hover:bg-amber-500/10 hover:text-amber-600 {open
        ? 'bg-amber-500/10 text-amber-600'
        : ''}"
      aria-label={m.post_more_actions_label()}
      title={m.post_more_actions_label()}
    >
      <Ellipsis size={18} strokeWidth={2.5} />
    </button>

    {#if open}
      <div
        role="menu"
        tabindex="-1"
        class="bg-surface-elevated border-cn-border absolute top-full right-3 z-(--z-popover) flex w-56 flex-col gap-0.5 rounded-xl border p-1.5 shadow-lg"
        transition:slide={{ duration: 150 }}
        onkeydown={(e) => {
          if (e.key === 'Escape') open = false;
        }}
      >
        <button
          type="button"
          role="menuitem"
          onclick={() => pick(sharePost)}
          class="{ROW} text-text-main hover:bg-amber-500/10 hover:text-amber-600"
        >
          {#if copiedLink}
            <Check size={16} strokeWidth={2.5} />
            {m.post_link_copied_label()}
          {:else}
            <Link size={16} strokeWidth={2.5} />
            {m.post_share_label()}
          {/if}
        </button>

        {#if canPin}
          <button
            type="button"
            role="menuitem"
            onclick={() => pick(onTogglePin)}
            class="{ROW} text-text-main hover:bg-amber-500/10 hover:text-amber-500"
          >
            {#if pinned}
              <PinOff size={16} strokeWidth={2.5} />
              {m.post_unpin_action_label()}
            {:else}
              <Pin size={16} strokeWidth={2.5} />
              {m.post_pin_action_label()}
            {/if}
          </button>
        {/if}

        {#if canManage}
          <button
            type="button"
            role="menuitem"
            onclick={() => pick(onStartEdit)}
            class="{ROW} text-text-main hover:bg-amber-500/10 hover:text-amber-500"
          >
            <Pencil size={16} strokeWidth={2.5} />
            {m.post_edit_post_label()}
          </button>
          <button
            type="button"
            role="menuitem"
            onclick={() => pick(onDelete)}
            class="{ROW} text-red-500 hover:bg-red-500/10"
          >
            <Trash2 size={16} strokeWidth={2.5} />
            {m.post_delete_post_label()}
          </button>
        {/if}

        {#if canReport}
          <button
            type="button"
            role="menuitem"
            onclick={() => pick(onReport)}
            class="{ROW} text-red-500 hover:bg-red-500/10"
          >
            <Flag size={16} strokeWidth={2.5} />
            {m.post_report_post_title()}
          </button>
        {/if}
      </div>
    {/if}
  </div>
{/if}
