<script lang="ts">
  import {
    AtSign,
    CornerDownLeft,
    MessageCircle,
    Clock,
    CalendarClock,
    CalendarCheck,
    CalendarX,
    CalendarCog,
  } from '@lucide/svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import { reactionTypeToEmoji } from '$lib/posts/reactions';
  import { formatRelative } from '$lib/utils/time';
  import { formatMentionsForPreview } from '$lib/utils/mentions.parse';
  import { MENTION_USER_ID_PATTERN, normalizeMentionUserId } from '$lib/utils/mentions';
  import { resolveUserDisplayName } from '$lib/utils/users/displayName';
  import type { PostNotification } from '$lib/posts/api';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The notification to render. */
    notif: PostNotification;
    /**
     * Whether to draw this row as new. Deliberately NOT `notif.read`: both surfaces mark everything
     * read the moment they open, so a row styled from the live flag is new for one frame and then
     * indistinguishable. The caller passes a snapshot taken before that call.
     */
    unread: boolean;
    /** Tighter geometry for the bell dropdown, which is 320px wide rather than a full column. */
    compact?: boolean;
    /** Called when the row is activated. */
    onOpen: () => void;
  }

  let { notif, unread, compact = false, onOpen }: Props = $props();

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
  ] as const;
  const isEventNotif = $derived((EVENT_TYPES as readonly string[]).includes(notif.type));

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
            : notif.type === 'event_rejected'
              ? 'bg-red-500 text-white'
              : isEventNotif
                ? 'bg-sky-600 text-white'
                : 'bg-green-600 text-white'
  );

  const avatarBox = $derived(compact ? 'h-10 w-10' : 'h-14 w-14');
  const badgeBox = $derived(compact ? 'h-5 w-5' : 'h-7 w-7');
  const glyph = $derived(compact ? 12 : 15);
</script>

<button
  type="button"
  onclick={onOpen}
  class="flex w-full items-start gap-3 rounded-lg text-left transition-colors hover:bg-black/5 dark:hover:bg-white/10 {compact
    ? 'px-3 py-2.5'
    : 'px-2 py-2.5'}"
>
  <!--
    Actor avatar with the type badge punched out of its lower-right corner. The ring is the row's
    own ground, not a colour: it is what separates the badge from the photo behind it without
    drawing an outline.
  -->
  <span class="relative shrink-0 {avatarBox}">
    <Avatar userId={notif.actorId} fill fallbackLabel={notif.actorName} />
    <span
      class="ring-cn-surface absolute -right-0.5 -bottom-0.5 flex items-center justify-center rounded-full ring-2 {badgeBox} {badgeClass}"
      aria-hidden="true"
    >
      {#if notif.type === 'reaction'}
        <span class="leading-none" style:font-size="{glyph}px"
          >{reactionTypeToEmoji(notif.text)}</span
        >
      {:else if notif.type === 'mention'}
        <AtSign size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'reply'}
        <CornerDownLeft size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'form_reminder'}
        <Clock size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'event_proposed'}
        <CalendarClock size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'event_validated'}
        <CalendarCheck size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'event_rejected' || notif.type === 'event_deleted'}
        <CalendarX size={glyph} strokeWidth={2.75} />
      {:else if notif.type === 'event_updated'}
        <CalendarCog size={glyph} strokeWidth={2.75} />
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
    <p
      class="text-sm leading-snug {unread ? 'text-text-main' : 'text-text-muted'} {compact
        ? 'line-clamp-2'
        : ''}"
    >
      <span class="font-semibold">{notif.actorName || m.notif_actor_unknown()}</span>
      {#if notif.type === 'reaction'}
        {m.notif_reaction_text()}
      {:else if notif.type === 'mention'}
        {m.notif_mention_text()}
      {:else if notif.type === 'reply'}
        {m.notif_reply_text()}
      {:else if notif.type === 'form_reminder'}
        {bodyText}
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
                : m.notif_event_deleted_text()}
        <span class="italic">{eventTitle}</span>{#if eventReason}&#32;&#8212; {eventReason}{/if}
      {:else}
        {m.notif_comment_text()}
        <span class="italic">{bodyText}</span>
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
