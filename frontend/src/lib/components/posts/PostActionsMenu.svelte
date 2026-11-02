<script lang="ts">
  import {
    Pin,
    PinOff,
    Pencil,
    Trash2,
    Flag,
    Share2,
    Ellipsis,
    VenetianMask,
    Repeat2,
    Send,
    Undo2,
    Megaphone,
    X,
    Ban,
  } from '@lucide/svelte';
  import { Log } from '$lib/utils/Log';
  import { clickOutside } from '$lib/actions/clickOutside';
  import { portal } from '$lib/actions/portal';
  import { bindFixedPopover } from '$lib/actions/fixedPopover';
  import { bindHistoryOverlay } from '$lib/utils/bindHistoryOverlay.svelte';
  import { isMobileOverlayLayout } from '$lib/utils/historyOverlayStack';
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
   * `canReport`, `canRepublish`, `canProposeRepublication`, `canRequestRepublication`, and the
   * `canUnrepublishAs` and `republicationRequests` lists);
   * nothing here is derived from the post's contents. A card cannot tell its own
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
    /** May clear the anonymous flag on this post: same tier as `canPin`, only ever true when the
     *  post actually is anonymous - the server never sets it otherwise. */
    canUnmaskAnonymous: boolean;
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
    /** Called when a moderator picks "Remove anonymity". */
    onUnmaskAnonymous: () => void;
    /** Post id used for the public share link. */
    postId: string;
    /** May republish this post as one of their associations at once (D38). */
    canRepublish?: boolean;
    /** May propose this post to another association, which decides (D38). */
    canProposeRepublication?: boolean;
    /** The republications this reader may withdraw - one entry per republishing association. */
    unrepublishAs?: { id: string; name: string }[];
    /** Called when the reader picks "Republier": the card opens `RepublishDialog`. */
    onRepublish?: () => void;
    /** Called when the reader picks "Proposer a une association". */
    onProposeRepublication?: () => void;
    /** Called with the association whose republication the reader withdraws. */
    onUnrepublish?: (associationId: string) => void;
    /** May ask the AUTHOR of this personal post to let one of their associations carry it (D38b). */
    canRequestRepublication?: boolean;
    /** The requests of the reader's associations still waiting on the author, one entry each. */
    pendingRequests?: { proposalId: string; name: string }[];
    /** Called when the reader picks "Republier au nom d'une association". */
    onRequestRepublication?: () => void;
    /** Called with the request (a proposal id) the reader cancels. */
    onWithdrawRequest?: (proposalId: string) => void;
    /** WP-F6: may repost it to their followers - the share sheet's row. */
    canRepost?: boolean;
    /** WP-F6: reposted it already - the share sheet's row takes it back. */
    repostedByMe?: boolean;
    /** WP-F6: the repost's state after the reader's tap in the share sheet. */
    onRepostChange?: (repostedByMe: boolean) => void;
    /**
     * WP-F6: the AUTHOR's own post only - whether member reposts of it are allowed now. Draws the
     * entry that flips it; absent on anyone else's post.
     */
    repostsAllowed?: boolean;
    /** WP-F6: the author picked "Autoriser" (true) or "Interdire" (false) for this post. */
    onSetRepostConsent?: (allow: boolean) => void;
  }

  let {
    pinned,
    canManage,
    canPin,
    canReport,
    canUnmaskAnonymous,
    isLoggedIn,
    onTogglePin,
    onStartEdit,
    onDelete,
    onReport,
    onUnmaskAnonymous,
    postId,
    canRepublish = false,
    canProposeRepublication = false,
    unrepublishAs = [],
    onRepublish = () => {},
    onProposeRepublication = () => {},
    onUnrepublish = () => {},
    canRequestRepublication = false,
    pendingRequests = [],
    onRequestRepublication = () => {},
    onWithdrawRequest = () => {},
    canRepost = false,
    repostedByMe = false,
    onRepostChange = () => {},
    repostsAllowed,
    onSetRepostConsent = () => {},
  }: Props = $props();

  let open = $state(false);
  let buttonEl: HTMLButtonElement | null = $state(null);
  let menuEl: HTMLDivElement | null = $state(null);

  /**
   * Positions the portalled menu against its trigger button.
   *
   * PORTALLED BECAUSE A CARD HOVER TRAP SWALLOWED THE Z-INDEX. `PostCard` lifts on hover
   * (`hover:-translate-y-0.5`), and a `transform` creates a stacking context - silently, per
   * `docs/wiki/durable-rules.md`'s z-index section. The card the menu opens on is exactly the one
   * being hovered, so opening the menu was the one moment its own card became an isolated
   * context; `z-(--z-popover)` then only won against the OTHER things inside that same context,
   * and the whole card - popover included - painted under the next post in the feed, whose plain
   * `z-index: auto` box comes later in DOM order at the same layer. No number fixes a trap that
   * isolates the element the number is on; escaping to `<body>` does, same as `UserAutocomplete`.
   */
  $effect(() => {
    if (!open || !menuEl || !buttonEl) return;
    return bindFixedPopover(menuEl, { anchor: () => buttonEl, alignEnd: true, offset: 4 });
  });

  // On a phone the open menu holds a history entry: the system Back closes the menu, not the feed
  // or the post under it (audit of 2026-10-13). A wide window's popover is closed by a click beside it.
  bindHistoryOverlay(
    () => open && isMobileOverlayLayout(),
    () => (open = false)
  );

  /** Runs a menu entry and closes the menu, which every entry does. */
  function pick(action: () => void) {
    open = false;
    action();
  }

  /**
   * "Partager" opens the post's share sheet (`PostShareSheet`): send into a conversation, copy the
   * link, the system sheet. It is loaded on the first open, never with the card: the sheet reads
   * the conversation list (`globalChatSingleton`), weight no card that is only scrolled past should
   * pay - the reason `LinkPreviewCard` loads `PostMedia` the same way.
   *
   * The sheet lives OUTSIDE the menu: `pick()` closes the menu on the same tap, and anything drawn
   * inside it unmounts with it (the toast rule of 2026-09-27).
   */
  let ShareSheet = $state<typeof import('./PostShareSheet.svelte').default | null>(null);
  let shareOpen = $state(false);

  function openShareSheet() {
    import('./PostShareSheet.svelte')
      .then((mod) => {
        ShareSheet = mod.default;
        shareOpen = true;
      })
      .catch((e: unknown) =>
        Log.d('PostActionsMenu', `the share sheet did not load: ${String(e)}`)
      );
  }

  /** One row per action: same box, same padding, so the menu reads as a list rather than a pile. */
  const ROW =
    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors';
</script>

{#if isLoggedIn}
  <!--
    `shrink-0` because `PostHeader` is the flex item that gives: the name takes whatever this row
    leaves, which is now one button wide at every width. The panel itself is portalled and
    positioned against the button (see the effect above), not anchored to this wrapper.
  -->
  <div class="flex shrink-0 items-center pt-3 pr-3" use:clickOutside={() => (open = false)}>
    <button
      bind:this={buttonEl}
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
      <!-- Portalled so the card's own hover transform cannot trap it - see the effect above. -->
      <div
        bind:this={menuEl}
        use:portal
        role="menu"
        tabindex="-1"
        class="glass-chrome border-cn-border fixed z-(--z-popover) flex w-56 flex-col gap-0.5 overflow-auto rounded-xl p-1.5"
        transition:slide={{ duration: 150 }}
        onkeydown={(e) => {
          if (e.key === 'Escape') open = false;
        }}
      >
        <button
          type="button"
          role="menuitem"
          onclick={() => pick(openShareSheet)}
          class="{ROW} text-text-main hover:bg-amber-500/10 hover:text-amber-600"
        >
          <Share2 size={16} strokeWidth={2.5} />
          {m.post_share_label()}
        </button>

        {#if canRepublish}
          <button
            type="button"
            role="menuitem"
            onclick={() => pick(onRepublish)}
            class="{ROW} text-text-main hover:bg-amber-500/10 hover:text-amber-600"
          >
            <Repeat2 size={16} strokeWidth={2.5} />
            {m.post_republish_action()}
          </button>
        {/if}

        {#if canProposeRepublication}
          <button
            type="button"
            role="menuitem"
            onclick={() => pick(onProposeRepublication)}
            class="{ROW} text-text-main hover:bg-amber-500/10 hover:text-amber-600"
          >
            <Send size={16} strokeWidth={2.5} />
            {m.post_propose_republication_action()}
          </button>
        {/if}

        {#if canRequestRepublication}
          <button
            type="button"
            role="menuitem"
            onclick={() => pick(onRequestRepublication)}
            class="{ROW} text-text-main hover:bg-amber-500/10 hover:text-amber-600"
          >
            <Megaphone size={16} strokeWidth={2.5} />
            {m.post_request_republication_action()}
          </button>
        {/if}

        {#each pendingRequests as pending (pending.proposalId)}
          <button
            type="button"
            role="menuitem"
            onclick={() => pick(() => onWithdrawRequest(pending.proposalId))}
            class="{ROW} text-text-main hover:bg-amber-500/10 hover:text-amber-600"
          >
            <X size={16} strokeWidth={2.5} />
            <span class="truncate">{m.post_request_withdraw_action({ name: pending.name })}</span>
          </button>
        {/each}

        {#each unrepublishAs as republisher (republisher.id)}
          <button
            type="button"
            role="menuitem"
            onclick={() => pick(() => onUnrepublish(republisher.id))}
            class="{ROW} text-text-main hover:bg-amber-500/10 hover:text-amber-600"
          >
            <Undo2 size={16} strokeWidth={2.5} />
            <span class="truncate">{m.post_unrepublish_action({ name: republisher.name })}</span>
          </button>
        {/each}

        {#if repostsAllowed !== undefined}
          <button
            type="button"
            role="menuitem"
            data-repost-consent
            onclick={() => pick(() => onSetRepostConsent(!repostsAllowed))}
            class="{ROW} text-text-main hover:bg-amber-500/10 hover:text-amber-600"
          >
            {#if repostsAllowed}
              <Ban size={16} strokeWidth={2.5} />
              {m.post_repost_consent_forbid()}
            {:else}
              <Repeat2 size={16} strokeWidth={2.5} />
              {m.post_repost_consent_allow()}
            {/if}
          </button>
        {/if}

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

        {#if canUnmaskAnonymous}
          <button
            type="button"
            role="menuitem"
            onclick={() => pick(onUnmaskAnonymous)}
            class="{ROW} text-text-main hover:bg-amber-500/10 hover:text-amber-500"
          >
            <VenetianMask size={16} strokeWidth={2.5} />
            {m.post_action_unmask_anonymous()}
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

  {#if ShareSheet}
    <ShareSheet
      open={shareOpen}
      {postId}
      onClose={() => (shareOpen = false)}
      {canRepost}
      {repostedByMe}
      onRepostChange={(_id, reposted) => onRepostChange(reposted)}
    />
  {/if}
{/if}
