<script lang="ts">
  /**
   * ONE CONVERSATION OF THE LIST (mockups "Boîte de réception", "Sélection multiple").
   *
   * The avatar, the senders, the date, the subject with the message count, the fragment, the clip
   * and the star - bold while unread. A press opens it; a hold, or a press on the avatar, selects it
   * (then every press toggles). The swipe is the LIST's (`MailList` hears the touch once for every
   * row, `mailGestures.ts` decides); the row only paints the offset it is handed and the action
   * revealed under it.
   */
  import { Archive, Check, Paperclip, Star, Trash2 } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import AvatarPlaceholder from '$lib/components/shared/AvatarPlaceholder.svelte';
  import { longPress } from '$lib/actions/longPress';
  import { m } from '$lib/paraglide/messages';
  import type { ConversationSummary } from '$lib/mail/mailTypes';
  import type { MailSwipeAction } from '$lib/mail/mailGestures';
  import { displayNameOf, mailListDate, sendersLine } from '$lib/mail/mailFormat';
  import { getInitials } from '$lib/utils/avatar';

  interface Props {
    conversation: ConversationSummary;
    /** The account's addresses, so its own name reads "moi". */
    self: readonly string[];
    /** The reference instant of the dates, taken once by the list. */
    now: number;
    selected: boolean;
    /** A selection is under way: a press toggles instead of opening. */
    selecting: boolean;
    /** The conversation open beside the list (wide layout). */
    active: boolean;
    /** The swipe's drawn offset, in px (0 at rest). */
    offset: number;
    /** What letting go does now, when armed. */
    armed: MailSwipeAction | null;
    onOpen: (id: string) => void;
    onToggle: (id: string) => void;
  }

  let {
    conversation,
    self,
    now,
    selected,
    selecting,
    active,
    offset,
    armed,
    onOpen,
    onToggle,
  }: Props = $props();

  const unread = $derived(conversation.unreadCount > 0 || conversation.flags.unread);
  const firstSender = $derived(conversation.senders[0] ?? null);
  const initials = $derived(firstSender ? getInitials(displayNameOf(firstSender)) : '?');
  const senders = $derived(sendersLine(conversation.senders, self));
  const subject = $derived(conversation.subject || m.mail_no_subject());

  function press() {
    if (selecting) onToggle(conversation.id);
    else onOpen(conversation.id);
  }
</script>

<li
  class="relative overflow-hidden"
  data-conversation-id={conversation.id}
  data-unread={unread ? '' : undefined}
>
  {#if offset !== 0}
    <div
      class="absolute inset-0 flex items-center px-5 text-sm font-extrabold {offset > 0
        ? 'bg-accent text-on-accent justify-start'
        : 'bg-red-solid justify-end text-white'}"
      aria-hidden="true"
    >
      {#if offset > 0}
        <span class="flex items-center gap-2 {armed ? '' : 'opacity-60'}">
          <Archive size={20} />{m.mail_action_archive()}
        </span>
      {:else}
        <span class="flex items-center gap-2 {armed ? '' : 'opacity-60'}">
          {m.mail_action_trash()}<Trash2 size={20} />
        </span>
      {/if}
    </div>
  {/if}
  <div
    class="relative flex items-start gap-3 px-4 py-2.5 {selected
      ? 'bg-accent/20'
      : active
        ? 'bg-cn-surface-alt'
        : unread
          ? 'bg-accent/5'
          : 'bg-cn-surface'}"
    style={offset !== 0 ? `transform: translateX(${offset}px)` : undefined}
    use:longPress={{
      onHold: () => onToggle(conversation.id),
      pointerTypes: ['touch', 'pen'],
    }}
  >
    <Button
      variant="bare"
      class="shrink-0 rounded-full"
      aria-label={selected ? m.mail_unselect() : m.mail_select()}
      aria-pressed={selected}
      onclick={() => onToggle(conversation.id)}
      data-mail-row-avatar
    >
      {#if selected}
        <span class="bg-cn-dark flex h-11 w-11 items-center justify-center rounded-full text-white">
          <Check size={22} aria-hidden="true" />
        </span>
      {:else}
        <AvatarPlaceholder
          seed={firstSender?.address ?? conversation.id}
          {initials}
          class="h-11 w-11 rounded-full text-base"
        />
      {/if}
    </Button>
    <Button
      variant="bare"
      class="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
      onclick={press}
      data-mail-row-open
    >
      <span class="flex items-baseline gap-2">
        <span
          class="text-text-main min-w-0 flex-1 truncate text-base {unread
            ? 'font-extrabold'
            : 'font-normal'}">{senders}</span
        >
        <span
          class="shrink-0 text-xs {unread ? 'text-accent-text font-extrabold' : 'text-text-muted'}"
          >{mailListDate(conversation.date, now)}</span
        >
      </span>
      <span class="flex items-center gap-1.5">
        <span
          class="text-text-main min-w-0 flex-1 truncate text-sm {unread
            ? 'font-extrabold'
            : 'font-normal'}">{subject}</span
        >
        {#if conversation.messageCount > 1}
          <span class="text-text-muted shrink-0 text-xs font-bold">{conversation.messageCount}</span
          >
        {/if}
      </span>
      <span class="flex items-center gap-1.5">
        <span class="text-text-muted min-w-0 flex-1 truncate text-sm">{conversation.fragment}</span>
        {#if conversation.flags.attachment}
          <Paperclip
            size={15}
            class="text-text-muted shrink-0"
            aria-label={m.mail_has_attachment()}
          />
        {/if}
        {#if conversation.flags.flagged}
          <Star
            size={16}
            class="text-accent-icon shrink-0 fill-current"
            aria-label={m.mail_flagged()}
          />
        {/if}
      </span>
      {#if unread}<span class="sr-only">{m.mail_unread()}</span>{/if}
    </Button>
  </div>
</li>
