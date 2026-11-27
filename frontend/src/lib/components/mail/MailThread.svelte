<script lang="ts">
  /**
   * A CONVERSATION OPENED (mockup "Lecture d'un fil", the desktop's third column).
   *
   * Loaded whole (`MailApi.conversation`), oldest first: the newest message open, the earlier ones
   * folded to one line each, and beyond two of them a "N messages plus anciens" pill. An unread
   * conversation is marked read as it opens - one call, through the store, so the list and the
   * badge follow. The HTML body is sandboxed (`MailHtmlFrame`, D9); a text body is text.
   */
  import { untrack } from 'svelte';
  import {
    Download,
    Forward,
    LoaderCircle,
    Reply,
    ReplyAll,
    Star,
    TriangleAlert,
  } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import AvatarPlaceholder from '$lib/components/shared/AvatarPlaceholder.svelte';
  import MailActionBar from './MailActionBar.svelte';
  import MailHtmlFrame from './MailHtmlFrame.svelte';
  import MailStatePanel from './MailStatePanel.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { MailClient } from '$lib/mail/mailClient.svelte';
  import { classifyMailFailure, type MailError } from '$lib/mail/mailErrors';
  import { mailErrorRetryable, mailErrorText } from '$lib/mail/mailErrorText';
  import {
    attachmentFileName,
    displayNameOf,
    isSelf,
    mailFullDate,
    mailListDate,
  } from '$lib/mail/mailFormat';
  import { isInlineImagePart } from '$lib/mail/mailHtml';
  import type { MailConversation, MailMessage } from '$lib/mail/mailTypes';
  import type { MailUiAction } from '$lib/mail/mailView';
  import { getInitials } from '$lib/utils/avatar';
  import { formatFileSize } from '$lib/utils/fileSize';
  import { saveBlobAs } from '$lib/utils/fileDownload';
  import { showToast } from '$lib/stores/toast.svelte';
  import { Log } from '$lib/utils/Log';

  interface Props {
    client: MailClient;
    conversationId: string;
    /** The account's addresses ("moi"). */
    self: readonly string[];
    canArchive: boolean;
    /** Draws the back arrow (the narrow layout, where the thread replaces the list). */
    showBack: boolean;
    onBack: () => void;
    /** An action on this conversation (the screen applies it, then closes the thread if it left). */
    onAction: (action: MailUiAction, ids: string[]) => void;
    onMore: (ids: string[], flagged: boolean) => void;
    /** Reply, reply all, forward. */
    onCompose: (kind: 'reply' | 'reply_all' | 'forward', message: MailMessage) => void;
  }

  let {
    client,
    conversationId,
    self,
    canArchive,
    showBack,
    onBack,
    onAction,
    onMore,
    onCompose,
  }: Props = $props();

  let conversation = $state<MailConversation | null>(null);
  let failure = $state<MailError | null>(null);
  let loading = $state(false);
  let expanded = $state<ReadonlySet<string>>(new Set());
  let showOlder = $state(false);

  async function load(id: string) {
    Log.d('MAIL-UI', 'thread open');
    loading = true;
    failure = null;
    try {
      const opened = await client.api.conversation(id);
      if (id !== conversationId) return;
      conversation = opened;
      const last = opened.messages.at(-1);
      expanded = new Set(last ? [last.id] : []);
      showOlder = false;
      if (opened.messages.some((msg) => msg.flags.unread)) {
        try {
          await client.store.act('read', [id]);
          if (conversation?.id === id) {
            conversation.messages = conversation.messages.map((msg) => ({
              ...msg,
              flags: { ...msg.flags, unread: false },
            }));
          }
        } catch (err) {
          Log.w('MAIL-UI', `the thread was not marked read (${classifyMailFailure(err).kind})`);
        }
      }
    } catch (err) {
      if (id !== conversationId) return;
      failure = classifyMailFailure(err);
      Log.w('MAIL-UI', `the thread did not open (${failure.kind})`);
    } finally {
      if (id === conversationId) loading = false;
    }
  }

  $effect(() => {
    const id = conversationId;
    untrack(() => {
      conversation = null;
      void load(id);
    });
  });

  const messages = $derived(conversation?.messages ?? []);
  const anyUnread = $derived(messages.some((msg) => msg.flags.unread));
  const flagged = $derived(messages.some((msg) => msg.flags.flagged));
  /** Folded messages before the newest: the first one stays, the middle ones behind the pill. */
  const hiddenCount = $derived(showOlder || messages.length <= 3 ? 0 : messages.length - 2);
  const visible = $derived(
    hiddenCount === 0 ? messages : [messages[0], ...messages.slice(messages.length - 1)]
  );

  function toggleExpanded(id: string) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a copy, assigned whole to the state
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  function recipientsLine(message: MailMessage): string {
    const names = [...message.to, ...message.cc].map((a) =>
      isSelf(a, self) ? m.mail_sender_me() : displayNameOf(a)
    );
    return names.length ? m.mail_to_line({ names: names.join(', ') }) : '';
  }

  async function download(message: MailMessage, index: number) {
    const attachment = message.attachments[index];
    Log.d('MAIL-UI', 'attachment download');
    try {
      const bytes = await client.api.download(attachment);
      await saveBlobAs(
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: attachment.contentType }),
        attachmentFileName(attachment.filename)
      );
    } catch (err) {
      const kind = classifyMailFailure(err).kind;
      Log.w('MAIL-UI', `attachment download failed (${kind})`);
      showToast(mailErrorText(kind));
    }
  }
</script>

<div class="flex min-h-0 flex-1 flex-col" data-mail-thread>
  <MailActionBar
    mode="thread"
    {anyUnread}
    {canArchive}
    {showBack}
    {onBack}
    onAction={(action) => onAction(action, [conversationId])}
    onMore={() => onMore([conversationId], flagged)}
  />

  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
    {#if failure && !conversation}
      <MailStatePanel
        Icon={TriangleAlert}
        tone="error"
        title={mailErrorText(failure.kind)}
        onRetry={mailErrorRetryable(failure.kind) ? () => void load(conversationId) : undefined}
        busy={loading}
      />
    {:else if !conversation}
      <div class="flex justify-center py-10" role="status">
        <LoaderCircle size={24} class="text-text-muted animate-spin" aria-hidden="true" />
        <span class="sr-only">{m.mail_loading()}</span>
      </div>
    {:else}
      <div class="flex items-start gap-2 py-3">
        <h1 class="font-display text-text-main flex-1 text-2xl font-semibold break-words">
          {conversation.subject || m.mail_no_subject()}
        </h1>
        <Button
          variant="ghost"
          icon
          aria-label={flagged ? m.mail_action_unflag() : m.mail_action_flag()}
          aria-pressed={flagged}
          onclick={() => onAction(flagged ? 'unflag' : 'flag', [conversationId])}
        >
          <Star size={22} class={flagged ? 'text-accent-icon fill-current' : ''} />
        </Button>
      </div>

      <div class="flex flex-col gap-3">
        {#each visible as message, i (message.id)}
          {@const sender = message.from}
          {@const senderName = sender
            ? isSelf(sender, self)
              ? m.mail_sender_me()
              : displayNameOf(sender)
            : m.mail_sender_unknown()}
          {#if i === 1 && hiddenCount > 0}
            <Button
              variant="soft"
              size="compact"
              class="self-start rounded-full"
              onclick={() => (showOlder = true)}
            >
              {m.mail_older_messages({ count: hiddenCount })}
            </Button>
          {/if}
          {#if !expanded.has(message.id)}
            <Button
              variant="bare"
              class="bg-cn-surface-alt flex items-center gap-3 rounded-lg px-3 py-2 text-left"
              onclick={() => toggleExpanded(message.id)}
              data-mail-message-folded
            >
              <AvatarPlaceholder
                seed={sender?.address ?? message.id}
                initials={getInitials(senderName)}
                class="h-8 w-8 shrink-0 rounded-full text-xs"
              />
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="text-text-main truncate text-sm font-bold">{senderName}</span>
                <span class="text-text-muted truncate text-sm">{message.fragment}</span>
              </span>
              <span class="text-text-muted shrink-0 text-xs"
                >{mailListDate(message.date, Date.now())}</span
              >
            </Button>
          {:else}
            <article class="flex flex-col gap-3" data-mail-message>
              <div class="flex items-start gap-3">
                <AvatarPlaceholder
                  seed={sender?.address ?? message.id}
                  initials={getInitials(senderName)}
                  class="h-10 w-10 shrink-0 rounded-full text-sm"
                />
                <Button
                  variant="bare"
                  class="flex min-w-0 flex-1 flex-col text-left"
                  onclick={() => toggleExpanded(message.id)}
                  aria-expanded="true"
                >
                  <span class="flex items-baseline gap-2">
                    <span class="text-text-main min-w-0 flex-1 truncate text-base font-extrabold"
                      >{senderName}</span
                    >
                    <span class="text-text-muted shrink-0 text-xs"
                      >{mailFullDate(message.date)}</span
                    >
                  </span>
                  {#if sender}
                    <span class="text-text-muted truncate text-xs">{sender.address}</span>
                  {/if}
                  <span class="text-text-muted truncate text-xs">{recipientsLine(message)}</span>
                </Button>
                <Button
                  variant="ghost"
                  icon
                  aria-label={m.mail_reply()}
                  onclick={() => onCompose('reply', message)}
                >
                  <Reply size={20} />
                </Button>
              </div>

              {#if message.html !== null}
                <MailHtmlFrame
                  html={message.html}
                  attachments={message.attachments}
                  api={client.api}
                  title={conversation.subject || m.mail_no_subject()}
                />
              {:else}
                <p class="text-text-main text-base break-words whitespace-pre-wrap">
                  {message.text ?? message.fragment}
                </p>
              {/if}

              {#if message.attachments.some((a) => !isInlineImagePart(a))}
                <ul class="flex flex-wrap gap-2">
                  {#each message.attachments as attachment, index (attachment.part)}
                    {#if !isInlineImagePart(attachment)}
                      <li>
                        <Button
                          variant="bare"
                          class="border-cn-border flex items-center gap-3 rounded-lg border py-2 pr-3 pl-2 text-left"
                          onclick={() => void download(message, index)}
                          aria-label={m.mail_attachment_download({ name: attachment.filename })}
                        >
                          <span
                            class="bg-cn-surface-alt text-text-main flex h-9 w-9 items-center justify-center rounded-lg"
                            aria-hidden="true"
                          >
                            <Download size={18} />
                          </span>
                          <span class="flex min-w-0 flex-col">
                            <span class="text-text-main max-w-48 truncate text-sm font-bold"
                              >{attachment.filename}</span
                            >
                            <span class="text-text-muted text-xs"
                              >{formatFileSize(attachment.size)}</span
                            >
                          </span>
                        </Button>
                      </li>
                    {/if}
                  {/each}
                </ul>
              {/if}
            </article>
          {/if}
        {/each}
      </div>
    {/if}
  </div>

  {#if conversation && messages.length}
    {@const last = messages[messages.length - 1]}
    <!-- One line on a phone: "Répondre à tous" says "À tous" beside its icon below `sm`, and keeps its
         whole name for a screen reader. -->
    <div class="border-cn-border bg-cn-surface flex gap-2 border-t px-4 py-2" data-mail-reply-bar>
      <Button variant="secondary" class="flex-1" onclick={() => onCompose('reply', last)}>
        <Reply size={18} aria-hidden="true" />{m.mail_reply()}
      </Button>
      <Button
        variant="secondary"
        class="flex-1"
        aria-label={m.mail_reply_all()}
        onclick={() => onCompose('reply_all', last)}
      >
        <ReplyAll size={18} aria-hidden="true" /><span class="sm:hidden"
          >{m.mail_reply_all_short()}</span
        ><span class="hidden sm:inline">{m.mail_reply_all()}</span>
      </Button>
      <Button variant="secondary" class="flex-1" onclick={() => onCompose('forward', last)}>
        <Forward size={18} aria-hidden="true" />{m.mail_forward()}
      </Button>
    </div>
  {/if}
</div>
