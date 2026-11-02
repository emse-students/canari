<script lang="ts">
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import {
    AtSign,
    CornerDownLeft,
    MessageCircle,
    Clock,
    CalendarClock,
    CalendarCheck,
    CalendarX,
    UserCheck,
    UserPlus,
    UserX,
    CalendarCog,
    Newspaper,
    Repeat2,
    CalendarPlus,
    CalendarMinus,
    Bell,
    VideoOff,
    TriangleAlert,
    CircleCheck,
    Undo2,
    CirclePause,
    Store,
  } from '@lucide/svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import { reactionTypeToEmoji } from '$lib/posts/reactions';
  import { formatRelative } from '$lib/utils/time';
  import { formatMentionsForPreview } from '$lib/utils/mentions.parse';
  import { MENTION_USER_ID_PATTERN, normalizeMentionUserId } from '$lib/utils/mentions';
  import { resolveUserDisplayName } from '$lib/utils/users/displayName';
  import type { PostNotification } from '$lib/posts/api';
  import {
    isKnownNotificationType,
    reportUnknownNotificationType,
  } from '$lib/posts/notificationTarget';
  import { formatNoticeSlot, readBookingNoticeMeta } from '$lib/bookings/noticeText';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';
  import type { ReportReason } from '$lib/moderation/reasons';

  interface Props {
    /** The notification to render. */
    notif: PostNotification;
    /**
     * Whether to draw this row as new. Deliberately NOT `notif.read`: both surfaces mark everything
     * read the moment they open, so a row styled from the live flag is new for one frame and then
     * indistinguishable. The caller passes a snapshot taken before that call.
     */
    unread: boolean;
    /** Called when the row is activated. */
    onOpen: () => void;
    /** Actor names merged into this row, newest first. */
    actorNames?: string[];
  }

  let { notif, unread, onOpen, actorNames = [notif.actorName] }: Props = $props();
  const otherActorCount = $derived(Math.max(0, actorNames.length - 1));

  /**
   * A TYPE THIS BUILD DOES NOT KNOW (a newer server, an older app). The chain below used to end in
   * the COMMENT branch, so such a row read "<actor> a commente : <title>" with a link to a post that
   * does not exist. It now renders a neutral sentence, is not activatable, and is logged once.
   */
  const isUnknownNotif = $derived(!isKnownNotificationType(notif.type));
  $effect(() => {
    if (isUnknownNotif) reportUnknownNotificationType(notif.type);
  });

  /**
   * THE STRIKE LADDER'S THREE NOTICES TO A BROADCASTER: a live a moderator cut (`live_cut`), the
   * right to broadcast suspended (`live_suspended`, WP-L8b) or withdrawn (`live_withdrawn`). The
   * server writes each with NO actor (`actorId` and `actorName` are `''`: which moderator acted is
   * not the broadcaster's to read) and `text` = the reason CODE, so the whole sentence is built
   * here, in the reader's locale, and the avatar is a neutral disc. None has a destination (a cut
   * live is deleted; a suspension's end is the pre-live screen's to say), hence the row is not
   * activatable, like an unknown type.
   */
  const LIVE_MODERATION_TEXT: Readonly<Record<string, () => string>> = {
    live_cut: m.notif_live_cut_text,
    live_suspended: m.notif_live_suspended_text,
    live_withdrawn: m.notif_live_withdrawn_text,
  };
  const liveModerationText = $derived(
    Object.hasOwn(LIVE_MODERATION_TEXT, notif.type) ? LIVE_MODERATION_TEXT[notif.type]() : null
  );
  const isLiveModerationNotif = $derived(liveModerationText !== null);
  const LIVE_MODERATION_REASON_LABEL: Record<ReportReason, () => string> = {
    spam: m.moderation_reason_spam,
    harassment: m.moderation_reason_harassment,
    inappropriate: m.moderation_reason_inappropriate,
    other: m.moderation_reason_other,
  };
  /** The reason's label, or null for a code this build does not know (the sentence stands alone). */
  const liveModerationReason = $derived(
    isLiveModerationNotif && Object.hasOwn(LIVE_MODERATION_REASON_LABEL, notif.text)
      ? LIVE_MODERATION_REASON_LABEL[notif.text as ReportReason]()
      : null
  );
  const isInert = $derived(isUnknownNotif || isLiveModerationNotif);

  /** Bumped once async name resolution completes, to re-render resolved mentions. */
  let resolveVersion = $state(0);

  /**
   * The body text, with `@[id]` tokens replaced by `@DisplayName`.
   *
   * This used to exist on the notifications page only, so the same notification read `@Marie` in the
   * page and `@[a3f2...]` in the bell dropdown - the divergence that comes free with a second copy
   * of a row. It lives with the row now, so there is one answer.
   */
  const bodyText = $derived.by(() => {
    void resolveVersion; // reactive dependency: re-run after names resolve
    return formatMentionsForPreview(notif.text);
  });

  // Warm the display-name cache for anyone mentioned in this row, then re-render.
  $effect(() => {
    if (!notif.text) return;
    const re = new RegExp(`@\\[(${MENTION_USER_ID_PATTERN})\\]`, 'gi');
    // A plain record rather than a Set: this is a local dedupe inside one effect run, and a Set
    // here trips `svelte/prefer-svelte-reactivity`, which cannot tell that nothing reads it.
    const seen: Record<string, true> = {};
    let match: RegExpExecArray | null;
    while ((match = re.exec(notif.text)) !== null) seen[normalizeMentionUserId(match[1])] = true;
    const ids = Object.keys(seen);
    if (ids.length === 0) return;
    let cancelled = false;
    void Promise.all(ids.map((id) => resolveUserDisplayName(id))).then(() => {
      if (!cancelled) resolveVersion++;
    });
    return () => {
      cancelled = true;
    };
  });

  /**
   * THE AGENDA'S FIVE, and why they are listed rather than pattern-matched on a prefix.
   *
   * A notification's type decides three things here - the badge glyph, its colour and the sentence -
   * and each one is a deliberate choice per type. A `startsWith('event_')` would make a sixth kind
   * silently inherit whatever the fallback is, which is exactly how these five spent their life in
   * the generic `{:else}` branch printing an English sentence the server had composed.
   */
  const EVENT_TYPES = [
    'event_proposed',
    'event_validated',
    'event_rejected',
    'event_updated',
    'event_deleted',
    'event_pending',
  ] as const;
  const isEventNotif = $derived((EVENT_TYPES as readonly string[]).includes(notif.type));

  /**
   * THE TWO PUBLICATION NOTICES, which spent their life reading "a commente :".
   *
   * Reported by the user on 2026-09-17: an association's post said the association had COMMENTED on
   * something. Three things were wrong at once and all three came from the same place - the generic
   * `{:else}` that ends this chain is the COMMENT branch, so any type it does not name inherits the
   * comment sentence, the comment glyph and the comment colour. The push already said "a publie"
   * (`notif_social_association_post_title` in `strings.xml`), so the phone and the page disagreed
   * about the same row, which is exactly what the `EVENT_TYPES` docblock above predicted would
   * happen again.
   *
   * ONE SENTENCE FOR BOTH, because the native tables use one for both: `actorName` is the
   * association for the first and the author for the second, and "a publie" is true either way.
   * The AVATAR is what separates them, and that is decided further down from `associationId`.
   */
  const POST_TYPES = ['association_post', 'followed_post'] as const;
  const isPostNotif = $derived((POST_TYPES as readonly string[]).includes(notif.type));

  /**
   * THE TWO REPUBLICATION NOTICES (D38), named for the same reason as the two above: left to the
   * `{:else}` they would read "a commente". `actorName` is an ASSOCIATION in both - the one that
   * republished, or the one proposing - so both draw its avatar.
   */
  const REPOST_TYPES = ['association_repost', 'repost_proposed'] as const;
  const isRepostNotif = $derived((REPOST_TYPES as readonly string[]).includes(notif.type));
  /**
   * A MEMBER'S REPOST (WP-F6), named for the same reason: a PERSON the reader follows reposted a
   * post, so it draws that person's avatar, and the body is the post's opening.
   */
  const isMemberRepostNotif = $derived(notif.type === 'member_repost');
  /**
   * A CO-ORGANISATION PROPOSAL (D39), named for the same reason: the ORGANISING association asks,
   * and the body is the event's title.
   */
  const isCoorganiseNotif = $derived(notif.type === 'coorganise_proposed');
  /**
   * THE THREE REQUESTS TO AN AUTHOR (D38b), named for the same reason. A request is asked BY an
   * association, so it draws the association's avatar; its answer is given by the AUTHOR, a person,
   * whose avatar the two answers draw. The body is the post's opening either way.
   */
  const PERSONAL_REPOST_TYPES = [
    'repost_personal_requested',
    'repost_personal_accepted',
    'repost_personal_refused',
  ] as const;
  const isPersonalRepostNotif = $derived(
    (PERSONAL_REPOST_TYPES as readonly string[]).includes(notif.type)
  );
  /** The actor is an association, whose logo stands in for a person's avatar. */
  const actorIsAssociation = $derived(
    (notif.type === 'association_post' ||
      isRepostNotif ||
      isCoorganiseNotif ||
      notif.type === 'repost_personal_requested' ||
      // An organiser of an association space cancelled or booked: the association acted (WP-N).
      notif.type === 'booking_cancelled' ||
      notif.type === 'booking_added' ||
      // The reminder carries the booked space's owning association (owner, 2026-10-30). A reminder
      // written before that, or for a link-only / personal space, has none: it keeps the neutral
      // avatar - a data gap in old rows, not a fallback path (logged below).
      notif.type === 'booking_reminder') &&
      !!notif.associationId
  );
  $effect(() => {
    if (notif.type === 'booking_reminder' && !notif.associationId) {
      Log.d('[NOTIF] booking reminder without an association: neutral avatar', {
        id: notif.id,
      });
    }
  });
  /**
   * THE TWO ANSWERS TO A PROFILE CORRECTION REQUEST (WP4b), listed for the same reason as the agenda's
   * five: a type this chain does not name would inherit the COMMENT sentence, glyph and colour. The
   * actor is the platform; `text` holds the admin's note on a refusal, shown after the sentence.
   */
  const PROFILE_TYPES = ['profile_correction_applied', 'profile_correction_refused'] as const;
  /**
   * A FOLLOW REQUEST AND ITS ACCEPTANCE (WP-F4), named for the same reason: left to the `{:else}`
   * they would read "a commente". The actor is a PERSON either way - the one asking, or the one who
   * said yes - and there is no text: the sentence is the whole notice.
   */
  const FOLLOW_TYPES = ['follow_request', 'follow_accepted'] as const;
  const isFollowNotif = $derived((FOLLOW_TYPES as readonly string[]).includes(notif.type));
  const isProfileNotif = $derived((PROFILE_TYPES as readonly string[]).includes(notif.type));
  /**
   * THE BOOKINGS' FOUR (WP-N), named for the same reason. `text` is the PLACE - or the organiser's
   * word for a cancellation (Q-R3), the place and the time for a reminder - and is EMPTY for a space
   * reached by its link only (Q-R5): the sentence then stands alone. The reminder has no actor (the
   * platform), so its sentence is the whole of it, like a moderation notice.
   */
  const BOOKING_TEXT: Readonly<Record<string, () => string>> = {
    booking_cancelled: m.notif_booking_cancelled_text,
    booking_withdrawn: m.notif_booking_withdrawn_text,
    booking_added: m.notif_booking_added_text,
  };
  /**
   * An association's Lydia payments became active or were paused (system actor): a whole sentence
   * naming the association, so the row carries no actor name before it.
   */
  const isLydiaPaymentsNotif = $derived(
    notif.type === 'lydia_payments_active' ||
      notif.type === 'lydia_payments_paused' ||
      notif.type === 'lydia_cashier_added'
  );
  /** The whole sentence of a Lydia notice, naming the association the row stores. */
  const lydiaNoticeText = $derived(
    notif.type === 'lydia_payments_active'
      ? m.notif_lydia_payments_active_text({ name: notif.text })
      : notif.type === 'lydia_payments_paused'
        ? m.notif_lydia_payments_paused_text({ name: notif.text })
        : m.notif_lydia_cashier_added_text({ name: notif.text })
  );
  /** An association refunded the reader (system actor): a whole sentence naming the association. */
  const isLydiaRefundNotif = $derived(notif.type === 'lydia_refund_issued');
  const isBookingReminder = $derived(notif.type === 'booking_reminder');
  const isBookingNotif = $derived(isBookingReminder || Object.hasOwn(BOOKING_TEXT, notif.type));
  /** The place and slot of a cancellation / withdrawal / booking; null (drawn as before) when `meta` is absent. */
  const bookingNotice = $derived(
    isBookingNotif && !isBookingReminder ? readBookingNoticeMeta(notif.meta) : null
  );
  const bookingSlot = $derived(
    bookingNotice ? formatNoticeSlot(bookingNotice.startsAt, bookingNotice.timeZone) : null
  );

  /**
   * A refusal carries its reason after a newline - the one thing a reader cannot reconstruct from
   * the title. Split here so the title can stay italic and the reason can read as prose.
   */
  const eventLines = $derived(bodyText.split(/\r?\n/));
  const eventTitle = $derived(eventLines[0]);
  const eventReason = $derived(eventLines.slice(1).join(' ').trim());

  /**
   * The badge fill, per type.
   *
   * The reference puts a small coloured disc on the ACTOR'S avatar rather than replacing the avatar
   * with a type icon, so the row answers "who" and "what" in that order - which is the order the eye
   * wants them. Canari's per-type colours survive the move; only their size and place change.
   */
  const badgeClass = $derived(
    notif.type === 'reaction'
      ? 'bg-pink-500 text-white'
      : notif.type === 'mention'
        ? 'bg-amber-500 text-cn-ink'
        : notif.type === 'reply'
          ? 'bg-blue-500 text-white'
          : notif.type === 'form_reminder'
            ? 'bg-purple-500 text-white'
            : notif.type === 'form_paid_over_capacity' || notif.type === 'lydia_payments_paused'
              ? 'bg-amber-500 text-cn-ink'
              : notif.type === 'event_rejected'
                ? 'bg-red-500 text-white'
                : notif.type === 'event_pending'
                  ? 'bg-amber-500 text-cn-ink'
                  : isEventNotif || isCoorganiseNotif
                    ? 'bg-sky-600 text-white'
                    : isPostNotif || isRepostNotif || isPersonalRepostNotif
                      ? 'bg-indigo-500 text-white'
                      : isFollowNotif
                        ? 'bg-amber-500 text-cn-ink'
                        : notif.type === 'profile_correction_refused'
                          ? 'bg-red-500 text-white'
                          : isUnknownNotif
                            ? 'bg-gray-500 text-white'
                            : isLiveModerationNotif
                              ? 'bg-red-500 text-white'
                              : 'bg-green-600 text-white'
  );

  // ONE GEOMETRY, BECAUSE THERE IS ONE SURFACE. These were `compact ? a : b`, and `compact` was
  // passed by exactly one caller: the 320px bell dropdown, deleted on 2026-09-14 when the bell
  // became a link to this page. A second shape nothing asks for is a second shape nobody checks.
  const avatarBox = 'h-14 w-14';
  const badgeBox = 'h-7 w-7';
  const glyph = 15;
</script>

<button
  type="button"
  disabled={isInert}
  aria-disabled={isInert}
  onclick={onOpen}
  class="flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left transition-colors {isInert
    ? 'cursor-default'
    : 'hover:bg-black/5 dark:hover:bg-white/10'}"
>
  <!--
    Actor avatar with the type badge punched out of its lower-right corner. The ring is the row's
    own ground, not a colour: it is what separates the badge from the photo behind it without
    drawing an outline.
  -->
  <span class="relative shrink-0 {avatarBox}">
    {#if isLiveModerationNotif}
      <span
        class="bg-cn-border/60 text-text-muted flex h-full w-full items-center justify-center rounded-full"
        aria-hidden="true"
        data-notif-live-cut-avatar
      >
        <VideoOff size={24} />
      </span>
    {:else if actorIsAssociation}
      <AssociationAvatar
        id={notif.associationId ?? notif.actorId}
        name={notif.actorName}
        logoUrl={notif.associationLogoUrl}
        fill
      />
    {:else}
      <Avatar userId={notif.actorId} fill fallbackLabel={notif.actorName} />
    {/if}
    <span
      class="ring-cn-surface absolute -right-0.5 -bottom-0.5 flex items-center justify-center rounded-full ring-2 {badgeBox} {badgeClass}"
      aria-hidden="true"
    >
      {#if notif.type === 'reaction'}
        <span class="leading-none" style:font-size="{glyph}px"
          ><EmojiText text={reactionTypeToEmoji(notif.text)} /></span
        >
      {:else if notif.type === 'mention'}
        <AtSign size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'reply'}
        <CornerDownLeft size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'form_reminder'}
        <Clock size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'form_paid_over_capacity'}
        <TriangleAlert size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'lydia_payments_active'}
        <CircleCheck size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'lydia_payments_paused'}
        <CirclePause size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'lydia_cashier_added'}
        <Store size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'lydia_refund_issued'}
        <Undo2 size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'event_proposed'}
        <CalendarClock size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'event_validated'}
        <CalendarCheck size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'event_rejected' || notif.type === 'event_deleted'}
        <CalendarX size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'event_updated'}
        <CalendarCog size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'event_pending'}
        <CalendarClock size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'profile_correction_applied'}
        <UserCheck size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'profile_correction_refused'}
        <UserX size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'follow_request'}
        <UserPlus size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'follow_accepted'}
        <UserCheck size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'booking_cancelled'}
        <CalendarX size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'booking_withdrawn'}
        <CalendarMinus size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'booking_added'}
        <CalendarPlus size={glyph} strokeWidth={2.75} />
      {:else if isBookingReminder}
        <Clock size={glyph} strokeWidth={2.75} />
      {:else if isPostNotif}
        <Newspaper size={glyph} strokeWidth={2.75} />
      {:else if isRepostNotif || isPersonalRepostNotif}
        <Repeat2 size={glyph} strokeWidth={2.75} />
      {:else if isCoorganiseNotif}
        <CalendarPlus size={glyph} strokeWidth={2.75} />
      {:else if isUnknownNotif}
        <Bell size={glyph} strokeWidth={2.75} />
      {:else if isLiveModerationNotif}
        <VideoOff size={glyph} strokeWidth={2.75} />
      {:else}
        <MessageCircle size={glyph} strokeWidth={2.75} />
      {/if}
    </span>
  </span>

  <div class="min-w-0 flex-1">
    <!--
      ONE COLOUR FOR THE WHOLE SENTENCE, and the read state is what changes it. Canari used to paint
      the actor's name dark and the rest muted, which reads as two pieces of information; the
      reference paints the whole line one colour and leans on weight 600 for the names, so what the
      colour carries is "have I seen this" and nothing else.
    -->
    <p class="text-sm leading-snug {unread ? 'text-text-main' : 'text-text-muted'}">
      {#if isUnknownNotif}
        {m.notif_unknown_type_text()}
      {:else if isLiveModerationNotif}
        <span class="font-semibold">{liveModerationText}</span>
      {:else if isBookingReminder}
        <span class="font-semibold">{m.notif_booking_reminder_text()}</span>
      {:else if isLydiaPaymentsNotif}
        <span class="font-semibold"><EmojiText text={lydiaNoticeText} /></span>
      {:else if isLydiaRefundNotif}
        <span class="font-semibold"
          ><EmojiText text={m.notif_lydia_refund_issued_text({ name: notif.text })} /></span
        >
      {:else}
        <span class="font-semibold"
          ><EmojiText text={actorNames[0] || m.notif_actor_unknown()} /></span
        >
      {/if}
      {#if isUnknownNotif || isLiveModerationNotif || isBookingReminder || isLydiaPaymentsNotif || isLydiaRefundNotif}
        <!-- Neutral and unlinked: nothing more to say about a type this build cannot read. -->
      {:else if otherActorCount === 1}
        {m.notif_grouped_one_other()}
      {:else if otherActorCount > 1}
        {m.notif_grouped_many_others({ count: otherActorCount })}
      {/if}
      {#if notif.type === 'reaction'}
        {m.notif_reaction_text()}
      {:else if notif.type === 'mention'}
        {m.notif_mention_text()}
      {:else if notif.type === 'reply'}
        {m.notif_reply_text()}
      {:else if notif.type === 'form_reminder'}
        <EmojiText text={bodyText} />
      {:else if notif.type === 'form_paid_over_capacity'}
        <!-- A payment landed on a full form: the sentence is built here, in the reader's locale,
             from the type and the form's title - the only data the server stores on the row. -->
        {m.notif_form_paid_over_capacity_text()}
        <span class="italic"><EmojiText text={bodyText} /></span>
      {:else if isLydiaPaymentsNotif || isLydiaRefundNotif}
        <!-- The whole sentence is the first span above; nothing follows it. -->
      {:else if isLiveModerationNotif}
        {#if liveModerationReason}&#8212; {liveModerationReason}{/if}
      {:else if isEventNotif}
        <!-- Built HERE, in the reader's own locale, from a type and a title - never printed back
             from a sentence the server composed. That is the whole repair. -->
        {notif.type === 'event_proposed'
          ? m.notif_event_proposed_text()
          : notif.type === 'event_validated'
            ? m.notif_event_validated_text()
            : notif.type === 'event_rejected'
              ? m.notif_event_rejected_text()
              : notif.type === 'event_updated'
                ? m.notif_event_updated_text()
                : notif.type === 'event_pending'
                  ? m.notif_event_pending_text()
                  : m.notif_event_deleted_text()}
        <span class="italic"><EmojiText text={eventTitle} /></span>{#if eventReason}&#32;&#8212; <EmojiText
            text={eventReason}
          />{/if}
      {:else if isProfileNotif}
        {notif.type === 'profile_correction_applied'
          ? m.notif_profile_correction_applied_text()
          : m.notif_profile_correction_refused_text()}
        {#if bodyText}<span class="italic"><EmojiText text={bodyText} /></span>{/if}
      {:else if isPostNotif}
        {m.notif_post_text()}
        <span class="italic"><EmojiText text={bodyText} /></span>
      {:else if isMemberRepostNotif}
        {m.notif_member_repost_text()}
        <span class="italic"><EmojiText text={bodyText} /></span>
      {:else if isRepostNotif}
        {notif.type === 'repost_proposed'
          ? m.notif_repost_proposed_text()
          : m.notif_association_repost_text()}
        <span class="italic"><EmojiText text={bodyText} /></span>
      {:else if isPersonalRepostNotif}
        {notif.type === 'repost_personal_requested'
          ? m.notif_repost_personal_requested_text()
          : notif.type === 'repost_personal_accepted'
            ? m.notif_repost_personal_accepted_text()
            : m.notif_repost_personal_refused_text()}
        <span class="italic"><EmojiText text={bodyText} /></span>
      {:else if isBookingNotif}
        {#if !isBookingReminder}{BOOKING_TEXT[notif.type]()}{/if}
        {#if bookingNotice}
          <!-- The space, then the slot on the space's clock in the reader's locale; the organiser's
               word (`meta.word`, plain text) on its own line. -->
          {#if bookingNotice.place}<span class="italic"
              ><EmojiText text={bookingNotice.place} /></span
            >{#if bookingSlot}&#32;&#183;&#32;{/if}{/if}{bookingSlot ?? ''}
          {#if bookingNotice.word}<span class="mt-0.5 block whitespace-pre-line italic"
              ><EmojiText text={m.notif_booking_word_quoted({ word: bookingNotice.word })} /></span
            >{/if}
        {:else if bodyText}<span class="italic"><EmojiText text={bodyText} /></span>{/if}
      {:else if isFollowNotif}
        {notif.type === 'follow_request'
          ? m.notif_follow_request_text()
          : m.notif_follow_accepted_text()}
      {:else if isCoorganiseNotif}
        {m.notif_coorganise_proposed_text()}
        <span class="italic"><EmojiText text={bodyText} /></span>
      {:else if !isUnknownNotif}
        {m.notif_comment_text()}
        <span class="italic"><EmojiText text={bodyText} /></span>
      {/if}
    </p>
    <!--
      The timestamp carries the unread signal, in the brand colour. The reference uses its own accent
      blue here; Canari's accent is the yellow, and an app with no other blue in its palette calling
      "unread" blue is the incoherence this pass exists to remove.
    -->
    <p
      class="mt-0.5 text-xs {unread
        ? 'font-semibold text-amber-600 dark:text-amber-400'
        : 'text-text-muted'}"
    >
      {formatRelative(notif.createdAt)}
    </p>
  </div>

  {#if unread}
    <span class="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true"></span>
  {/if}
</button>
