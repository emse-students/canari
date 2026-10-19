<script lang="ts">
  import { publicSectionHref } from '$lib/associations/publicSections';
  import {
    votePoll,
    addComment,
    likeComment as likeCommentApi,
    editComment as editCommentApi,
    deleteComment as deleteCommentApi,
    getPost,
    pinPost as pinPostApi,
    unpinPost as unpinPostApi,
    unmaskPost as unmaskPostApi,
    unrepublishPost as unrepublishPostApi,
    type PostEntity,
    type PostComment,
    type Poll,
  } from '$lib/posts/api';
  import { Log } from '$lib/utils/Log';
  import { deletePostAfterConfirm } from '$lib/posts/postDeletion';
  import { createReport, ModerationApiError } from '$lib/moderation/api';
  import type { ReportReason } from '$lib/moderation/reasons';
  import ReportReasonDialog from '$lib/components/moderation/ReportReasonDialog.svelte';
  import { assertNotMuted, cachedMuteStatus } from '$lib/moderation/muteCheck';
  import {
    DOUBLE_TAP_REACTION,
    onPostReactions,
    reactionRefusedLocally,
    sendPostReaction,
    toggledReactions,
  } from '$lib/posts/postReaction';
  import { doubleTapLike } from '$lib/actions/doubleTapLike';
  import type { Point } from '$lib/utils/viewerGestures';
  import DoubleTapHeart from './DoubleTapHeart.svelte';
  import { applyPostPollVote, nextPollSelection, pollDeadlinePassed } from '$lib/posts/pollVote';
  import { pollDeadlineClock } from '$lib/posts/pollDeadline.svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { publishFailureMessage } from '$lib/posts/publishFailure';
  import { PostCardLedger, servedAt } from '$lib/posts/postCardSync';
  import { getForm, checkSubmission } from '$lib/forms/api';
  import { attachedFormSources, attachedFormsLoader } from '$lib/posts/attachedForms.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import PostHeader from './PostHeader.svelte';
  import PostContent from './PostContent.svelte';
  import PostActions from './PostActions.svelte';
  import ReactionsDisplay from './ReactionsDisplay.svelte';
  import PostPolls from './PostPolls.svelte';
  import PostForms from './PostForms.svelte';
  import PostComments from './PostComments.svelte';
  import PostActionsMenu from './PostActionsMenu.svelte';
  import PostCornerBadge from './PostCornerBadge.svelte';
  import PostFeedback from './PostFeedback.svelte';
  import EditPostForm from './EditPostForm.svelte';
  import RepublishDialog from './RepublishDialog.svelte';
  import { Pin, CalendarCheck } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import { FORM_CARD_PLACEHOLDER_MIN_HEIGHT } from '$lib/utils/mediaLayout';
  import { REACTIONS } from '$lib/posts/reactions';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  /**
   * Props for the PostCard component.
   * The card is self-contained: it manages its own local copy of the post
   * and updates it optimistically after each user interaction.
   */
  interface Props {
    /**
     * The post data to render. The card keeps a local copy; a NEW row object replaces it, field by
     * field, through `PostCardLedger` (a field this card wrote more recently is kept).
     */
    post: PostEntity;
    /** ID of the authenticated user, used to gate edit/delete/reaction controls. */
    currentUserId: string;
    /** Bearer token forwarded to media URLs that require auth. */
    authToken?: string;
    /** Called after a full list refresh is needed (e.g. after delete from the parent). */
    onRefresh?: () => void;
    /** Called immediately after the post has been deleted so the parent can remove the card. */
    onDelete?: () => void;
    /**
     * Whether the comment section starts open.
     *
     * FALSE IN A FEED, TRUE ON A POST'S OWN PAGE, and the distinction is the reader's intent. The
     * composer is no longer drawn at rest (it cost 90 px in every card, see `PostComments`), so a
     * card that starts closed shows none - correct for a feed being scrolled past, wrong for
     * `/posts/[postId]`, which a reader reached by following a link to THAT post and where the
     * comments are most of what they came for. Facebook opens the section on a post's own page for
     * the same reason.
     */
    commentsOpen?: boolean;
    /** The comment a notification tap opened this post at: scrolled to and marked once drawn. */
    focusCommentId?: string;
  }

  let {
    post: postProp,
    currentUserId,
    authToken = '',
    onRefresh: _onRefresh,
    onDelete,
    commentsOpen = false,
    focusCommentId,
  }: Props = $props();

  // Local mutable copy - updated directly after interactions to avoid a full list reload.
  let localPost = $state.raw<PostEntity>(untrack(() => ({ ...postProp })));

  /**
   * This card's writes, and the rule deciding what a new served row may replace.
   *
   * A NEW ROW FROM THE PARENT REPLACES THE COPY (`PostCardLedger.adopt`). The copy used to be taken
   * once, so a card drawn from the feed's stored page kept no rights and `canVote: false` for the
   * whole session after the server's page replaced its row - the keyed list keeps the card (review
   * of #1896). A field a write of this card still carries, or answered AFTER the row's read was
   * issued, is kept: a feed GET sent before a tap can land after the tap's own POST answered. A row
   * keeps its identity while the parent only re-slices or filters its list (Svelte's proxies), so
   * only a real answer is adopted. EVERY WRITE BELOW GOES THROUGH THE LEDGER.
   */
  const ledger = new PostCardLedger(untrack(() => postProp));
  /** Whether the reader expanded the whole thread, which a feed row (the first few) cannot carry. */
  let fullThread = false;
  $effect.pre(() => {
    const served = postProp;
    if (served === ledger.served) return;
    localPost = ledger.adopt(
      untrack(() => localPost),
      served
    );
    // The thread was kept from the card; ask for it again so it is as new as the row.
    if (fullThread) untrack(() => void loadAllComments());
  });

  let actionMessage = $state('');
  let errorMessage = $state('');
  let editingPost = $state(false);
  let selectedOptions = $state<string[]>([]);

  /**
   * The instant this card's deadlines are judged against - see {@link pollDeadlineClock}.
   *
   * It exists because the old spelling read `Date.now()` during render, which is not reactive: a
   * deadline arriving while the card was on screen flipped nothing until an unrelated redraw.
   */
  const deadlineClock = pollDeadlineClock(() => localPost.polls ?? []);

  /**
   * Whether a poll has closed - ONE spelling, read by the renderer and by the tap handler.
   *
   * A post poll's deadline is a date its author picked, hours or days out, so comparing it to this
   * browser's clock is sound; a channel poll's is not, which is why `PostPolls` takes this as a
   * prop rather than deciding for every caller (COMM-15).
   */
  function pollIsOver(poll: Poll): boolean {
    return pollDeadlinePassed(poll.endsAt, deadlineClock.at);
  }

  /**
   * This reader's selection WITHIN one poll.
   *
   * `selectedOptions` is flat across every poll on the card, which was invisible while a post
   * could only carry one: a tap on a single-choice poll replaced the whole array, so it cleared
   * the reader's answer to the poll next to it, and `submitVote` then sent that poll's ids to
   * THIS poll's endpoint. A cap makes the same confusion arithmetic - "two answers max" counting
   * answers given elsewhere - so the split is stated here once.
   */
  function selectionIn(poll: Poll): string[] {
    const ids = new Set(poll.options.map((o) => o.id));
    return selectedOptions.filter((id) => ids.has(id));
  }
  // Sync selectedOptions from the card's polls - not the prop's: a served row older than this
  // reader's last vote is not adopted for the polls, and the selection must say what the tally says.
  const localPolls = $derived(localPost.polls);
  $effect(() => {
    const serverVotes = (localPolls ?? []).flatMap((p) => p.votesByUser?.[currentUserId] ?? []);
    if (serverVotes.length > 0) {
      selectedOptions = serverVotes;
    }
  });
  let commentText = $state('');
  // `untrack` states what the prop IS: an initial value, read once. The card owns the open/closed
  // state from then on - a parent that flipped the prop later would otherwise fight the reader's
  // own taps on the comment button.
  let showComments = $state(untrack(() => commentsOpen));
  let submittingComment = $state(false);
  /**
   * Comments written into the list before the server acknowledged them, by their LOCAL id.
   *
   * Handed to `PostComments`, which withholds every control that would name an id to the server
   * for as long as a row is in here. Emptied in the `finally`, whichever way the write went.
   */
  const pendingCommentIds = new SvelteSet<string>();
  let showReactionPicker = $state(false);

  // Server-answered, per reader and per control. Never re-derived here: an association post carries
  // no `authorId` to compare against, and nothing in a post says whether its reader moderates.
  const canManage = $derived(localPost.canManage === true);
  const canPin = $derived(localPost.canPin === true);
  const canReport = $derived(localPost.canReport === true);
  const canUnmaskAnonymous = $derived(localPost.canUnmaskAnonymous === true);

  let userReaction = $derived((localPost.reactions ?? {})[currentUserId] ?? null);
  let reactions = $derived<Record<string, number>>((localPost.reactions ?? {}) as any);
  let reactionCounts = $derived.by(() => {
    const counts: Record<string, number> = {};
    for (const [, reactionType] of Object.entries(reactions)) {
      counts[reactionType] = (counts[reactionType] ?? 0) + 1;
    }
    return counts;
  });
  let comments = $derived<PostComment[]>(localPost.comments ?? []);
  let topLevelComments = $derived(comments.filter((c) => !c.parentId));

  // Each attached form read once and drawn once, keyed by form (`attachedFormsLoader`).
  const attachedForms = attachedFormsLoader(() => attachedFormSources(localPost), {
    getForm,
    checkSubmission,
  });
  const formInfos = $derived(attachedForms.infos);
  const pendingAttachedFormIds = $derived(attachedForms.pending);
  // Auto-clear error messages after 4 seconds.
  $effect(() => {
    if (errorMessage) {
      const timer = setTimeout(() => {
        errorMessage = '';
      }, 4000);
      return () => clearTimeout(timer);
    }
  });

  // Auto-clear success messages after 4 seconds.
  $effect(() => {
    if (actionMessage) {
      const timer = setTimeout(() => {
        actionMessage = '';
      }, 4000);
      return () => clearTimeout(timer);
    }
  });

  /**
   * Handles a click on a poll option.
   * Single-choice: toggles the selection and immediately submits (click = vote, click again = remove).
   * Multiple-choice: toggles selection only; user submits manually with the "Voter" button.
   *
   * WHAT A TAP PRODUCES IS `nextPollSelection`, not an `if` written here: the cap has an edge
   * (a tap on one option too many does nothing) that has to be testable without a component, and
   * the server refuses the same rule rather than trusting this one.
   */
  function handleVoteClick(poll: Poll, optionId: string) {
    // A closed poll is a fact this card holds. Sending the vote to find out would be answered with
    // a 400 since 2026-09-23, and before that it was RECORDED - which is why the buttons say so.
    if (pollIsOver(poll)) return;
    // The server said this reader may not vote (a read grant opens the post, never its poll).
    if (localPost.canVote === false) return;
    // An anonymous vote is final, so there is nothing left to select once it has been cast.
    if (poll.anonymous && poll.voted) return;
    const mine = selectionIn(poll);
    const others = selectedOptions.filter((id) => !mine.includes(id));
    selectedOptions = [...others, ...nextPollSelection(mine, optionId, poll)];
    // An anonymous single-choice vote is NOT sent on the tap: it cannot be taken back, so it waits
    // for the explicit button like a multiple-choice one.
    if (!poll.multipleChoice && !poll.anonymous) void submitVote(poll.id, true);
  }

  /** Submits this poll's selection to the API and updates the local vote counts on success. */
  async function submitVote(pollId: string, allowEmpty = false) {
    if (!currentUserId.trim()) {
      errorMessage = m.post_identifier_avant();
      return;
    }
    const poll = (localPost.polls ?? []).find((p) => p.id === pollId);
    if (!poll) return;
    // ONLY THIS POLL'S OPTIONS TRAVEL. `votePoll` replaces the reader's whole answer to the poll
    // it names, so an id belonging to another poll on the same card used to be written into its
    // `votesByUser` - a selection the server then handed back to every reader of that poll.
    const optionIds = selectionIn(poll);
    if (!allowEmpty && optionIds.length === 0) {
      errorMessage = m.post_sondage_selectionner();
      return;
    }
    // THE TALLY IS COMPLETE ON THIS DEVICE, so it moves on the tap rather than on the answer.
    // This ran AFTER votePoll came back: a reader on a bad link tapped an option and watched
    // nothing happen for seconds. The channel-poll path had already reached the other conclusion
    // (applyLocalVote, called before the server); applyPostPollVote is the same decision for the
    // post shape, and it is pure, so the rollback is the post we came in with.
    const previousPolls = localPost.polls;
    localPost = applyPostPollVote(localPost, pollId, currentUserId, optionIds);
    actionMessage = optionIds.length === 0 ? m.post_vote_retire() : m.post_vote_enregistre();
    const token = ledger.begin(['polls']);
    try {
      await votePoll(localPost.id, pollId, { optionIds });
    } catch (err) {
      Log.d('PostCard.submitVote failed', err);
      // Only the polls go back, and to the newest served tally if one arrived meanwhile.
      localPost = ledger.rollback(localPost, 'polls', previousPolls, token);
      actionMessage = '';
      errorMessage = m.post_unable_to_vote();
    } finally {
      ledger.end(['polls']);
    }
  }

  /** Toggles a reaction on the post with an optimistic update. Rolls back the local state if the API call fails. */
  async function handleReaction(reactionType: string) {
    if (!currentUserId.trim()) return;

    // A MUTE ALREADY KNOWN REFUSES WITHOUT MOVING ANYTHING; one that is not known does not hold
    // the tap. The check used to be `await assertNotMuted()` placed FIRST, so the picker stayed
    // open and the tally stayed still until `GET /api/moderation/me/mute-status` answered - once
    // per five-minute window, on a link where that is seconds.
    if (reactionRefusedLocally()) {
      errorMessage = m.post_action_not_allowed();
      return;
    }

    // Optimistic update - apply immediately, roll back on error
    const prevReactions = { ...localPost.reactions };
    const { next, wasReacted } = toggledReactions(prevReactions, currentUserId, reactionType);
    localPost = { ...localPost, reactions: next };
    showReactionPicker = false;

    const token = ledger.begin(['reactions']);
    try {
      // Still never sent to a server certain to refuse it: when nothing is known, this asks -
      // behind a picker that has already closed and a tally that has already moved.
      const reactions = await sendPostReaction(localPost.id, reactionType, wasReacted);
      localPost = { ...localPost, reactions };
    } catch (err) {
      // NOT ALWAYS MODERATION. `assertNotMuted()` ASKS the server, so a dropped radio used to tell
      // the reader they are restricted by moderation, which is false and is about them.
      // `publishFailureMessage` keeps that line for the refusal and says "could not reach the
      // server" for the transport.
      Log.d('handleReaction failed', err);
      localPost = ledger.rollback(localPost, 'reactions', prevReactions, token);
      errorMessage = publishFailureMessage(err, m.post_reaction_error());
    } finally {
      ledger.end(['reactions']);
    }
  }

  let hearts = $state<DoubleTapHeart | undefined>();

  /**
   * A DOUBLE TAP ON THE CARD LIKES THE POST, AND NEVER UNLIKES IT (user, 2026-10-19; `doubleTapLike`).
   * It is the reaction picker's own path - `handleReaction` with "J'aime" - so a mute, a refusal and
   * a lost radio end exactly as a tap on the heart does. A reader who has already reacted, with any
   * reaction, is shown the heart and nothing is sent: a double tap never replaces a chosen reaction.
   * The heart is drawn only once the post carries the reader's reaction - a refused tap wrote none.
   */
  function likeOnDoubleTap(at: Point) {
    if (!currentUserId.trim()) return;
    if (userReaction) {
      Log.d('PostCard.doubleTap', `${localPost.id}: already reacted, heart only`);
    } else {
      Log.d('PostCard.doubleTap', `${localPost.id}: like`);
      // The synchronous half of `handleReaction` has run when this returns: the tally has moved,
      // or the refusal is on screen.
      void handleReaction(DOUBLE_TAP_REACTION);
    }
    if ((localPost.reactions ?? {})[currentUserId]) hearts?.burst(at);
  }

  /**
   * A like given to this post in the reel viewer (`ReelViewer`), answered by the server: the card
   * takes it, so closing the viewer shows the heart that was just given.
   */
  const postId = $derived(localPost.id);
  $effect(() =>
    onPostReactions(postId, (reactions) => {
      ledger.answered(['reactions']);
      localPost = { ...localPost, reactions };
    })
  );

  /** Enters edit mode (shows EditPostForm in place of PostContent). */
  function startEditPost() {
    editingPost = true;
  }

  /** Called by EditPostForm on successful save; merges the updated post and closes edit mode. */
  function onPostSaved(updated: PostEntity) {
    // Applied on the answer: a feed row read before it must not put the old text back. The
    // COMMENTS are not the edit's: an edit changes none, and the answer's list may be the feed's
    // first few where the card holds the expanded thread - so they are left as the card has them.
    const { comments: _notEdited, ...edited } = updated;
    ledger.answered(Object.keys(edited) as (keyof PostEntity)[]);
    localPost = { ...localPost, ...edited };
    editingPost = false;
  }

  /**
   * Deletes the post once its author confirms ({@link deletePostAfterConfirm}), then calls onDelete
   * so the parent can remove the card from the list. A declined confirmation changes nothing.
   */
  async function handleDeletePost() {
    try {
      if ((await deletePostAfterConfirm(localPost.id)) === 'declined') return;
      onDelete?.();
    } catch (err) {
      Log.d('handleDeletePost failed', err);
      errorMessage = m.post_unable_to_delete_post();
    }
  }

  /**
   * Fetches the full post (with all comments) to replace the truncated comment list returned by the
   * feed endpoint. From then on the card HOLDS the thread: a feed row carries only its first few
   * comments, so adopting it would collapse the thread - a new row asks for the thread again instead.
   */
  async function loadAllComments() {
    fullThread = true;
    ledger.hold('comments');
    try {
      const full = await getPost(localPost.id);
      localPost = ledger.mergeRead(localPost, { comments: full.comments }, servedAt(full));
    } catch (err) {
      Log.d('PostCard.loadAllComments failed - the thread shown is kept', err);
    }
  }

  /** Posts a new comment (or reply) and appends it to the local comments array. media is an optional encrypted GIF/image ref. */
  async function handleAddComment(
    parentId?: string,
    media?: import('$lib/posts/api').PostMediaRef
  ) {
    const text = commentText.trim();
    if (!text && !media) return;
    if (!currentUserId.trim()) return;

    // A mute already known refuses before anything is written; see `handleReaction`.
    if (cachedMuteStatus()?.isMuted) {
      errorMessage = m.post_action_not_allowed();
      return;
    }

    // THE COMMENT IS COMPLETE BEFORE IT IS SENT, so it is shown before it is sent. The box used to
    // keep the text and the send button stayed disabled for the whole round trip, which on a bad
    // link reads as an app that ignored the tap. The row carries a LOCAL id and is listed as
    // pending, which is what stops `PostComments` from offering to edit, delete or like something
    // the server has never heard of - its row replaces this one, id and all, when it answers.
    const pendingId = `pending-${crypto.randomUUID()}`;
    const pending: PostComment = {
      id: pendingId,
      userId: currentUserId,
      text,
      parentId: parentId ?? null,
      likes: [],
      createdAt: new Date().toISOString(),
      ...(media ? { media } : {}),
    };
    pendingCommentIds.add(pendingId);
    localPost = { ...localPost, comments: [...(localPost.comments ?? []), pending] };
    commentText = '';
    submittingComment = true;

    ledger.begin(['comments']);
    try {
      await assertNotMuted();
      const result = await addComment(localPost.id, { text, parentId, media });
      localPost = {
        ...localPost,
        comments: (localPost.comments ?? []).map((c) => (c.id === pendingId ? result.comment : c)),
      };
    } catch (err) {
      // Two causes wear this sentence: moderation refusing, and `addComment` failing. Only the
      // first is about the reader, and only the second is about the comment. Either way the row
      // goes, and the text goes back where the reader can send it again.
      // ONLY THE ROW THIS WRITE ADDED GOES: the list carries other writes of the reader (a heart
      // on a comment, another comment) that this failure says nothing about.
      console.error('[POST_CARD] comment refused', err);
      localPost = {
        ...localPost,
        comments: (localPost.comments ?? []).filter((c) => c.id !== pendingId),
      };
      if (!commentText.trim()) commentText = text;
      errorMessage = publishFailureMessage(err, m.post_unable_to_comment());
    } finally {
      ledger.end(['comments']);
      pendingCommentIds.delete(pendingId);
      submittingComment = false;
    }
  }

  /** Toggles a like on a comment and updates the local comment in-place. Fails silently to avoid disrupting UX. */
  async function handleLikeComment(commentId: string) {
    // THE HEART IS A MEMBERSHIP TEST ON AN ARRAY THIS DEVICE HOLDS. It used to move only when the
    // server answered, and a failure was swallowed - so on a bad link a tap did nothing at all and
    // said nothing either.
    const previous = (localPost.comments ?? []).find((c) => c.id === commentId);
    ledger.begin(['comments']);
    localPost = {
      ...localPost,
      comments: (localPost.comments ?? []).map((c) =>
        c.id === commentId
          ? {
              ...c,
              likes: c.likes.includes(currentUserId)
                ? c.likes.filter((id) => id !== currentUserId)
                : [...c.likes, currentUserId],
            }
          : c
      ),
    };
    try {
      const result = await likeCommentApi(localPost.id, commentId);
      localPost = {
        ...localPost,
        comments: (localPost.comments ?? []).map((c) => (c.id === commentId ? result.comment : c)),
      };
    } catch (err) {
      // Put the heart back rather than leaving a count this device invented - on THIS comment only:
      // the list carries other writes of the reader (a comment still sending) this failure is not about.
      Log.d('handleLikeComment failed', err);
      if (previous) {
        localPost = {
          ...localPost,
          comments: (localPost.comments ?? []).map((c) => (c.id === commentId ? previous : c)),
        };
      }
    } finally {
      ledger.end(['comments']);
    }
  }

  /** Sends the updated comment text to the API and replaces the matching comment in the local list. */
  async function handleEditComment(commentId: string, text: string) {
    try {
      const result = await editCommentApi(localPost.id, commentId, text);
      ledger.answered(['comments']);
      localPost = {
        ...localPost,
        comments: (localPost.comments ?? []).map((c) => (c.id === commentId ? result.comment : c)),
      };
    } catch (err) {
      Log.d('handleEditComment failed', err);
      errorMessage = m.post_unable_to_edit_comment();
    }
  }

  /** Deletes a comment and all its replies from both the API and the local comments array. */
  async function handleDeleteComment(commentId: string) {
    try {
      await deleteCommentApi(localPost.id, commentId);
      ledger.answered(['comments']);
      localPost = {
        ...localPost,
        comments: (localPost.comments ?? []).filter(
          (c) => c.id !== commentId && c.parentId !== commentId
        ),
      };
    } catch (err) {
      Log.d('handleDeleteComment failed', err);
      errorMessage = m.post_unable_to_delete_comment();
    }
  }

  /** Pins or unpins the post (admin only) and updates the local pinned flag on success. */
  async function togglePin() {
    try {
      const fn = localPost.pinned ? unpinPostApi : pinPostApi;
      const res = await fn(localPost.id);
      ledger.answered(['pinned']);
      localPost = { ...localPost, pinned: res.pinned };
      actionMessage = res.pinned ? m.post_epingle() : m.post_unpinned();
    } catch (err) {
      Log.d('togglePin failed', err);
      errorMessage = m.post_unable_to_toggle_pin();
    }
  }

  /** Clears the anonymous flag (moderator/admin only), revealing the author again. */
  async function unmaskAnonymous() {
    try {
      await unmaskPostApi(localPost.id);
      ledger.answered(['anonymous']);
      localPost = { ...localPost, anonymous: false };
      actionMessage = m.post_anonymous_removed();
    } catch (err) {
      Log.d('unmaskAnonymous failed', err);
      errorMessage = m.post_unable_to_unmask();
    }
  }

  /** Which republication dialog is open (D38), or `null`. */
  let republishMode = $state<'republish' | 'propose' | null>(null);

  /**
   * Re-reads the post after a republication changed it. The "Republie par" line and the three
   * republication controls are all the server's answer, so the card asks again rather than
   * guessing which of them moved.
   */
  async function reloadAfterRepublication() {
    try {
      const fresh = await getPost(localPost.id);
      localPost = ledger.mergeRead(localPost, fresh, servedAt(fresh));
    } catch (err) {
      Log.d('PostCard', `post reload after republication failed: ${String(err)}`);
    }
  }

  /** An association withdraws its own republication (D38). */
  async function unrepublish(associationId: string) {
    try {
      await unrepublishPostApi(localPost.id, associationId);
      actionMessage = m.post_unrepublish_done();
      await reloadAfterRepublication();
    } catch (err) {
      Log.d('PostCard', `unrepublish ${associationId.slice(0, 8)} failed: ${String(err)}`);
      errorMessage = m.post_republish_error();
    }
  }

  /** The republishers this reader may withdraw, named for the menu. */
  const unrepublishAs = $derived(
    (localPost.republishedBy ?? []).filter((r) => (localPost.canUnrepublishAs ?? []).includes(r.id))
  );

  /** Whether the post's own report dialog is open. A comment's is keyed by the comment instead. */
  let reportingPost = $state(false);
  let reportSubmitting = $state(false);

  /** The comment awaiting a reason in the report dialog, or null when the dialog is closed. */
  let commentBeingReported = $state<PostComment | null>(null);

  /**
   * Turns a report refusal into an inline message.
   *
   * The duplicate case is read off the server's `code`, never off its wording - see
   * {@link ModerationApiError}. Anything else is a real failure and is SHOWN: this path used to
   * swallow every error on the comment side, so a moderation outage looked exactly like a
   * successful report to the person filing it.
   */
  function reportFailed(err: unknown, alreadyMessage: string) {
    if (err instanceof ModerationApiError && err.isAlreadyReported) {
      actionMessage = alreadyMessage;
      return;
    }
    Log.d('PostCard.reportFailed', err);
    errorMessage = m.post_unable_to_report();
  }

  /** Opens the reason dialog for a comment. Same four reasons a post offers. */
  function handleReportComment(commentId: string) {
    const comment = (localPost.comments ?? []).find((c) => c.id === commentId) ?? null;
    if (!comment) {
      Log.d('PostCard.handleReportComment', `unknown comment ${commentId}`);
      return;
    }
    commentBeingReported = comment;
  }

  /** Files the report for the comment currently in the dialog. */
  async function submitCommentReport(reason: ReportReason) {
    const comment = commentBeingReported;
    if (!comment) return;
    reportSubmitting = true;
    try {
      await createReport('comment', comment.id, reason, undefined, comment.userId ?? null);
      actionMessage = m.post_comment_reported();
    } catch (err) {
      reportFailed(err, m.post_comment_already_reported());
    } finally {
      reportSubmitting = false;
      commentBeingReported = null;
    }
  }

  /** Submits the chosen reason for the post itself, through the same dialog a comment uses. */
  async function submitReport(reason: ReportReason) {
    reportSubmitting = true;
    try {
      await createReport('post', localPost.id, reason, undefined, localPost.authorId ?? null);
      actionMessage = m.post_signalement_merci();
    } catch (err) {
      reportFailed(err, m.post_already_reported());
    } finally {
      reportingPost = false;
      reportSubmitting = false;
    }
  }
</script>

<!-- A DOUBLE TAP ANYWHERE ON THE POST LIKES IT (`doubleTapLike`): its text, its header's blank
     space, its picture or video, its poll's question. Not the action bar nor the comments
     (`data-no-double-tap`), and never a link, button, poll option or field inside it. Off while the
     post is being edited and for a reader who is not signed in. -->
<div
  class="relative mb-6"
  use:doubleTapLike={{
    onDoubleTap: likeOnDoubleTap,
    enabled: !editingPost && currentUserId.trim() !== '',
  }}
>
  <DoubleTapHeart bind:this={hearts} />
  {#if localPost.pinned}
    <PostCornerBadge label={m.post_pinned()}>
      {#snippet icon()}<Pin size={10} strokeWidth={3} />{/snippet}
    </PostCornerBadge>
  {/if}
  <!-- THE CARD STANDS OFF THE PAGE A LITTLE MORE (user, 2026-10-01, Mi 9T): `shadow-sm` at 5 %
       black on `--cn-bg` barely drew an edge in light mode, and in dark mode a `#121212` card on
       black was held by a 10 % hairline alone. A soft `shadow-md` lifts it in light; dark mode has
       no shadow to cast onto black, so its edge goes from 10 % to 15 %. -->
  <Card
    class="group/card bg-cn-surface border border-black/5 p-0! shadow-md shadow-black/8 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-xl dark:border-white/15 dark:shadow-none"
  >
    <!--
      THE MENU SHARES THE HEADER'S LINE; FIVE BUTTONS USED TO FLOAT OVER IT.
      This was `<div class="relative">` with the action row absolutely positioned `top-3 right-3` on
      top of `PostHeader`, whose name column is `flex-1` and therefore ran the full width of the card
      - underneath the buttons. Measured on A1 (Mi 9T, 436 x 945 CSS px) on 2026-09-14: the share
      icon's box (x 187-201) sat inside the association link "BDE - Bureau des Eleves" (x 83-229),
      14 x 8 px of overlap, on EVERY card in the feed. The `truncate` on that column could not help -
      it truncates at the column's width, and the column extended to the card's edge.

      Laying the row out beside the header instead fixed the overlap and exposed the real defect: the
      five 44 px targets then took 248 px of a 403 px card and the name was cut to "BDE - Bu...". The
      count is what was wrong, so `PostActionsMenu` collapses them into one overflow button and the
      name gets the rest - at every width, for every reader, whether they may do one thing or five.
    -->
    <div class="flex items-start">
      <PostHeader post={localPost} />
      <PostActionsMenu
        pinned={localPost.pinned ?? false}
        {canManage}
        {canPin}
        {canReport}
        {canUnmaskAnonymous}
        isLoggedIn={!!currentUserId}
        onTogglePin={togglePin}
        onStartEdit={startEditPost}
        onDelete={handleDeletePost}
        onReport={() => (reportingPost = true)}
        onUnmaskAnonymous={unmaskAnonymous}
        postId={localPost.id}
        canRepublish={localPost.canRepublish === true}
        canProposeRepublication={localPost.canProposeRepublication === true}
        {unrepublishAs}
        onRepublish={() => (republishMode = 'republish')}
        onProposeRepublication={() => (republishMode = 'propose')}
        onUnrepublish={unrepublish}
      />
    </div>

    {#if localPost.linkedCalendarEvent}
      {@const ev = localPost.linkedCalendarEvent}
      <div class="px-5 pb-3">
        <a
          href="{publicSectionHref(
            '/associations',
            ev.associationSlug,
            'calendar'
          )}?fromPost={encodeURIComponent(localPost.id)}"
          class="inline-flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-800 transition-colors hover:bg-amber-500/20 dark:text-amber-300"
        >
          <CalendarCheck size={14} strokeWidth={2.5} />
          <span>
            {m.post_event_label()}
            {ev.title}
            ·
            {new Date(ev.startsAt).toLocaleString(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </a>
      </div>
    {/if}

    {#if editingPost}
      <div class="px-4 pb-4 sm:px-5">
        <EditPostForm
          post={localPost}
          {authToken}
          onSaved={onPostSaved}
          onCancel={() => (editingPost = false)}
        />
      </div>
    {:else}
      <PostContent post={localPost} {authToken} likerId={currentUserId.trim() || undefined} />
    {/if}

    <!--
      THE TALLY SITS ON THE ACTION BAR, NOT UNDER IT. `ReactionsDisplay` used to be the next sibling
      and drew a second bordered row for it - 65 px of bar plus 49 px of tally on A1, where Facebook
      spends 44 px on both together. Passing it as a snippet keeps its five props here, where the
      post's reaction state already lives, while `PostActions` decides only where it sits.
    -->
    <div data-no-double-tap>
      <PostActions
        {userReaction}
        {showReactionPicker}
        reactionList={REACTIONS}
        commentCount={comments.length || undefined}
        onToggleReactionPicker={() => (showReactionPicker = !showReactionPicker)}
        onReactionSelect={handleReaction}
        onCommentClick={() => (showComments = !showComments)}
      >
        {#snippet reactionSummary()}
          <ReactionsDisplay
            {reactionCounts}
            reactions={localPost.reactions ?? {}}
            {userReaction}
            reactionList={REACTIONS}
            onReactionClick={handleReaction}
          />
        {/snippet}
      </PostActions>
    </div>

    <!--
      A post poll's deadline is a date its author picked, hours or days out, so comparing it to this
      clock is sound - and stating that here is the point: the renderer no longer decides for callers
      whose deadline came from a different clock (see PostPolls.isOver).
    -->
    <PostPolls
      polls={localPost.polls}
      {selectedOptions}
      onVoteClick={handleVoteClick}
      onSubmitVote={submitVote}
      isOver={pollIsOver}
      canVote={localPost.canVote !== false}
    />

    {#if pendingAttachedFormIds.length > 0}
      <div class="space-y-3 px-5 py-3" aria-hidden="true">
        {#each pendingAttachedFormIds as formId (formId)}
          <div
            class="animate-pulse rounded-2xl border border-black/5 bg-black/5 dark:border-white/10 dark:bg-white/5"
            style="min-height: {FORM_CARD_PLACEHOLDER_MIN_HEIGHT}"
          ></div>
        {/each}
      </div>
    {/if}

    <PostForms {formInfos} />

    <div data-no-double-tap>
      <PostComments
        {comments}
        {topLevelComments}
        {showComments}
        {commentText}
        {submittingComment}
        {pendingCommentIds}
        {currentUserId}
        {authToken}
        {focusCommentId}
        onToggleComments={() => (showComments = !showComments)}
        onCommentTextChange={async (text) => {
          commentText = text;
        }}
        onAddComment={handleAddComment}
        onLikeComment={handleLikeComment}
        onEditComment={handleEditComment}
        onDeleteComment={handleDeleteComment}
        onReport={handleReportComment}
        onLoadAllComments={loadAllComments}
        totalCommentCount={(localPost.comments ?? []).length}
      />
    </div>

    <!-- Inline card notifications. -->
    <PostFeedback {errorMessage} {actionMessage} />
  </Card>
</div>

<!--
  A comment and a post are reported through the same four reasons AND the same dialog, and until
  2026-09-14 the second half of that sentence was false: the post had its own 52 px-wide popover of
  radio buttons inside the header's action row, a second implementation of everything below.
-->
<ReportReasonDialog
  open={!!commentBeingReported}
  title={m.report_comment_dialog_title()}
  targetPreview={commentBeingReported?.text ?? ''}
  submitting={reportSubmitting}
  onSubmit={submitCommentReport}
  onClose={() => (commentBeingReported = null)}
/>

<ReportReasonDialog
  open={reportingPost}
  title={m.post_report_post_title()}
  targetPreview={localPost.markdown}
  submitting={reportSubmitting}
  onSubmit={submitReport}
  onClose={() => (reportingPost = false)}
/>

<!-- Mounted only while open: a feed of fifty cards does not need fifty idle pickers. -->
{#if republishMode}
  <RepublishDialog
    mode={republishMode}
    post={localPost}
    onClose={() => (republishMode = null)}
    onDone={() => {
      republishMode = null;
      void reloadAfterRepublication();
    }}
  />
{/if}
