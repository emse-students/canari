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
    Users,
  } from '@lucide/svelte';
  import { Log } from '$lib/utils/Log';
  import { clickOutside } from '$lib/actions/clickOutside';
  import { portal } from '$lib/actions/portal';
  import { bindFixedPopover } from '$lib/actions/fixedPopover';
  import { bindHistoryOverlay } from '$lib/utils/bindHistoryOverlay.svelte';
  import { isMobileOverlayLayout } from '$lib/utils/historyOverlayStack';
  import { slide } from 'svelte/transition';
  import { m } from '$lib/paraglide/messages';
  import { toggleMyRepost } from '$lib/posts/sharePost';
  import type { PinSpace } from '$lib/posts/api';
  import { campusLabel, formationLabel } from '$lib/profile/miconnectProfile';

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
    /**
     * WP-PIN: the spaces where this reader may pin the post, each with the pin's state there - one
     * entry per space, served by the server. With exactly one, the entry reads "Épingler" alone.
     */
    pinSpaces: PinSpace[];
    /**
     * May delete: the post's publisher (its author, or an officer of the association it speaks
     * for), a moderator of this post (a BDE MODERATE of its spaces), or a platform admin.
     */
    canManage: boolean;
    /**
     * May edit: the post's author (publisher) ALONE - never a moderator nor the platform admin
     * (owner, 2026-11-02). Required, never derived from `canManage`: that would hand the pencil back
     * to every moderator.
     */
    canEdit: boolean;
    /**
     * May pin or unpin (WP-PIN): the reader governs a space where the post is visible - the platform
     * admin, or `MODERATE` in that space's BDE. A promotion per space, not moderation.
     */
    canPin: boolean;
    /** May report: any logged-in reader who is not the post's own publisher. */
    canReport: boolean;
    /** May clear the anonymous flag on this post: a moderator of it or a platform admin, only ever
     *  true when the post actually is anonymous - the server never sets it otherwise. */
    canUnmaskAnonymous: boolean;
    /** Whether any user is logged in (gates the whole menu). */
    isLoggedIn: boolean;
    /** Called with the space the reader pins the post in, or unpins it from. */
    onTogglePin: (space: PinSpace) => void;
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
    /** Called when the reader picks "Demander a republier". */
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
    /**
     * WP-F6: the AUTHOR's own post only - how many people they are shown as having reposted it.
     * Above zero, draws "Republie par N personnes", which opens the list (`onShowReposters`).
     */
    reposterCount?: number;
    /** WP-F6: the author picked "Republie par N personnes". */
    onShowReposters?: () => void;
  }

  let {
    pinSpaces,
    canManage,
    canEdit,
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
    reposterCount = 0,
    onShowReposters = () => {},
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

  /** A space's name in the pin entries: its formation and campus, localized. */
  function spaceName(space: PinSpace): string {
    return m.post_pin_space_name({
      formation: formationLabel(space.formation),
      campus: campusLabel(space.campus),
    });
  }

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
    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors [&>svg]:shrink-0';
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
      class="ui-icon-button text-text-muted hover:bg-accent/10 hover:text-accent-text rounded-lg transition-colors outline-none {open
        ? 'bg-accent/10 text-accent-text'
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
          class="{ROW} text-text-main hover:bg-accent/10 hover:text-accent-text"
        >
          <Share2 size={16} strokeWidth={2.5} />
          {m.post_share_label()}
        </button>

        {#if repostedByMe || canRepost}
          <button
            type="button"
            role="menuitem"
            data-repost-row
            onclick={() =>
              pick(() => {
                void toggleMyRepost(postId, repostedByMe).then((reposted) =>
                  onRepostChange(reposted)
                );
              })}
            class="{ROW} text-text-main hover:bg-accent/10 hover:text-accent-text"
          >
            <Repeat2 size={16} strokeWidth={2.5} />
            {repostedByMe ? m.post_repost_undo_label() : m.post_repost_label()}
          </button>
        {/if}

        {#if canRepublish}
          <button
            type="button"
            role="menuitem"
            onclick={() => pick(onRepublish)}
            class="{ROW} text-text-main hover:bg-accent/10 hover:text-accent-text"
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
            class="{ROW} text-text-main hover:bg-accent/10 hover:text-accent-text"
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
            class="{ROW} text-text-main hover:bg-accent/10 hover:text-accent-text"
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
            class="{ROW} text-text-main hover:bg-accent/10 hover:text-accent-text"
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
            class="{ROW} text-text-main hover:bg-accent/10 hover:text-accent-text"
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
            class="{ROW} text-text-main hover:bg-accent/10 hover:text-accent-text"
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

        {#if reposterCount > 0}
          <button
            type="button"
            role="menuitem"
            data-post-reposters-open
            onclick={() => pick(onShowReposters)}
            class="{ROW} text-text-main hover:bg-accent/10 hover:text-accent-text"
          >
            <Users size={16} strokeWidth={2.5} />
            {m.post_reposters_menu({ count: reposterCount })}
          </button>
        {/if}

        {#if canPin}
          <!-- WP-PIN: one entry per space the reader governs and the post is seen in; with one,
               it pins there directly. A "pending" pin is kept but not shown (3 already are). -->
          {#each pinSpaces as space (space.spaceId)}
            <button
              type="button"
              role="menuitem"
              data-post-pin-space={space.spaceId}
              onclick={() => pick(() => onTogglePin(space))}
              class="{ROW} text-text-main hover:bg-accent/10 hover:text-accent-text"
            >
              {#if space.state !== null}
                <PinOff size={16} strokeWidth={2.5} />
                {pinSpaces.length === 1
                  ? m.post_unpin_action_label()
                  : m.post_unpin_in_space({ space: spaceName(space) })}
                {#if space.state === 'pending'}
                  <span class="text-text-muted text-xs">({m.post_pin_pending()})</span>
                {/if}
              {:else}
                <Pin size={16} strokeWidth={2.5} />
                {pinSpaces.length === 1
                  ? m.post_pin_action_label()
                  : m.post_pin_in_space({ space: spaceName(space) })}
              {/if}
            </button>
          {/each}
        {/if}

        {#if canUnmaskAnonymous}
          <button
            type="button"
            role="menuitem"
            onclick={() => pick(onUnmaskAnonymous)}
            class="{ROW} text-text-main hover:bg-accent/10 hover:text-accent-text"
          >
            <VenetianMask size={16} strokeWidth={2.5} />
            {m.post_action_unmask_anonymous()}
          </button>
        {/if}

        {#if canEdit}
          <button
            type="button"
            role="menuitem"
            onclick={() => pick(onStartEdit)}
            class="{ROW} text-text-main hover:bg-accent/10 hover:text-accent-text"
          >
            <Pencil size={16} strokeWidth={2.5} />
            {m.post_edit_post_label()}
          </button>
        {/if}

        {#if canManage}
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
