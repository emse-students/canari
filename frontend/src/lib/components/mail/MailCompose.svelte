<script lang="ts">
  /**
   * WRITING A MAIL (mockup "Nouveau message"): a new one, a reply, a reply to all, a forward - each
   * opened from `mailCompose.ts`'s prefilled message.
   *
   * The body is plain text (a reply's quote included, `> `), sent as text only: the composer edits
   * text, so an HTML half built when it opened would no longer say what the text says. A file is
   * uploaded as it is attached (`MailApi.upload`) and sent by its upload id. "Envoyer" sends ONCE -
   * the message carries its own `suid`, so a second press or a resend cannot send it twice. Closing a
   * composer with something written saves it as a draft (`SaveDraft`) instead of losing it.
   */
  import { Paperclip, Send, X } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import MailRecipientField from './MailRecipientField.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { MailApi } from '$lib/mail/mailApi';
  import { classifyMailFailure, type MailErrorKind } from '$lib/mail/mailErrors';
  import { mailErrorText } from '$lib/mail/mailErrorText';
  import type { OutgoingMessage, UploadedAttachment } from '$lib/mail/mailTypes';
  import { formatFileSize } from '$lib/utils/fileSize';
  import { showToast } from '$lib/stores/toast.svelte';
  import { Log } from '$lib/utils/Log';

  interface Props {
    api: Pick<MailApi, 'send' | 'saveDraft' | 'upload' | 'directory'>;
    /** The message the composer opens with. */
    initial: OutgoingMessage;
    /** The account's address, shown as "De". */
    from: string;
    /** The composer's title ("Nouveau message", "Répondre", "Transférer"). */
    title: string;
    onClose: () => void;
    onSent: () => void;
  }

  let { api, initial, from, title, onClose, onSent }: Props = $props();

  // The composer works on its own copy; `initial` is only where it starts.
  // svelte-ignore state_referenced_locally
  let draft = $state<OutgoingMessage>({ ...initial });
  // svelte-ignore state_referenced_locally
  let showCopies = $state(initial.cc.length > 0 || initial.bcc.length > 0);
  let uploading = $state<{ name: string; size: number }[]>([]);
  let sending = $state(false);
  let failure = $state<MailErrorKind | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);

  const recipientCount = $derived(draft.to.length + draft.cc.length + draft.bcc.length);
  const dirty = $derived(
    recipientCount > 0 ||
      draft.subject.trim() !== initial.subject.trim() ||
      draft.text.trim() !== initial.text.trim() ||
      draft.attachments.length > 0
  );

  async function attach(event: Event & { currentTarget: HTMLInputElement }) {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = '';
    Log.d('MAIL-UI', `attach ${files.length} file(s)`);
    for (const file of files) {
      const pending = { name: file.name, size: file.size };
      uploading = [...uploading, pending];
      try {
        const uploaded: UploadedAttachment = await api.upload({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
        draft.attachments = [...draft.attachments, uploaded];
      } catch (err) {
        const kind = classifyMailFailure(err).kind;
        Log.w('MAIL-UI', `an attachment did not upload (${kind})`);
        showToast(mailErrorText(kind));
      } finally {
        uploading = uploading.filter((u) => u !== pending);
      }
    }
  }

  function removeAttachment(uploadId: string) {
    draft.attachments = draft.attachments.filter((a) => a.uploadId !== uploadId);
  }

  /** The message as it is sent or saved: plain text, the HTML half dropped (see the module comment). */
  function outgoing(): OutgoingMessage {
    return { ...$state.snapshot(draft), html: null };
  }

  async function send() {
    if (sending || recipientCount === 0 || uploading.length) return;
    Log.d('MAIL-UI', `send (${recipientCount} recipient(s), ${draft.attachments.length} file(s))`);
    sending = true;
    failure = null;
    try {
      await api.send(outgoing());
      showToast(m.mail_sent(), 'info');
      onSent();
    } catch (err) {
      failure = classifyMailFailure(err).kind;
      Log.w('MAIL-UI', `send failed (${failure})`);
    } finally {
      sending = false;
    }
  }

  async function close() {
    if (!dirty || sending) {
      onClose();
      return;
    }
    Log.d('MAIL-UI', 'composer closed with content - saved as a draft');
    try {
      draft.draftId = await api.saveDraft(outgoing());
      showToast(m.mail_draft_saved(), 'info');
    } catch (err) {
      const kind = classifyMailFailure(err).kind;
      Log.w('MAIL-UI', `the draft was not saved (${kind})`);
      showToast(mailErrorText(kind));
      return;
    }
    onClose();
  }
</script>

<div class="bg-cn-surface flex h-full min-h-0 flex-col" data-mail-compose>
  <input
    bind:this={fileInput}
    type="file"
    multiple
    class="hidden"
    onchange={attach}
    data-mail-attach-input
  />
  <header class="flex items-center gap-1 px-2 py-2">
    <Button variant="ghost" icon aria-label={m.mail_compose_close()} onclick={() => void close()}>
      <X size={22} />
    </Button>
    <h1 class="font-display text-text-main min-w-0 flex-1 px-1 text-lg font-semibold break-words">
      {title}
    </h1>
    <Button
      variant="ghost"
      icon
      aria-label={m.mail_compose_attach()}
      onclick={() => fileInput?.click()}
    >
      <Paperclip size={22} />
    </Button>
    <!-- The label shows from `sm`: on a phone the title needs the width ("Nouveau message" on one line). -->
    <Button
      onclick={() => void send()}
      loading={sending}
      disabled={recipientCount === 0 || uploading.length > 0}
      aria-label={m.mail_compose_send()}
    >
      <Send size={18} aria-hidden="true" /><span class="hidden sm:inline"
        >{m.mail_compose_send()}</span
      >
    </Button>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="border-cn-border flex items-center gap-1.5 border-b px-4 py-2.5 text-sm">
      <span class="text-text-muted w-10 shrink-0 font-semibold">{m.mail_compose_from()}</span>
      <span class="text-text-main truncate">{from}</span>
    </div>
    <MailRecipientField label={m.mail_compose_to()} id="mail-to" bind:recipients={draft.to} {api} />
    {#if showCopies}
      <MailRecipientField
        label={m.mail_compose_cc()}
        id="mail-cc"
        bind:recipients={draft.cc}
        {api}
      />
      <MailRecipientField
        label={m.mail_compose_bcc()}
        id="mail-bcc"
        bind:recipients={draft.bcc}
        {api}
      />
    {:else}
      <div class="border-cn-border flex justify-end border-b px-4 py-1">
        <Button variant="link" onclick={() => (showCopies = true)}>{m.mail_compose_copies()}</Button
        >
      </div>
    {/if}
    <div class="border-cn-border border-b px-4 py-1.5">
      <Input
        id="mail-subject"
        bind:value={draft.subject}
        placeholder={m.mail_compose_subject()}
        aria-label={m.mail_compose_subject()}
        class="[&_input]:border-transparent [&_input]:bg-transparent [&_input]:px-0"
      />
    </div>
    <textarea
      bind:value={draft.text}
      aria-label={m.mail_compose_body()}
      placeholder={m.mail_compose_body_placeholder()}
      class="text-text-main placeholder:text-text-muted min-h-60 w-full resize-none bg-transparent px-4 py-3 text-base outline-none"
    ></textarea>

    {#if draft.attachments.length || uploading.length || draft.forwardedParts.length}
      <ul class="flex flex-wrap gap-2 px-4 pb-3">
        {#each draft.attachments as attachment (attachment.uploadId)}
          <li
            class="border-cn-border flex items-center gap-2 rounded-lg border py-1.5 pr-1 pl-3 text-sm"
          >
            <span class="text-text-main max-w-48 truncate font-bold">{attachment.filename}</span>
            <span class="text-text-muted text-xs">{formatFileSize(attachment.size)}</span>
            <Button
              variant="ghost"
              size="compact"
              icon
              aria-label={m.mail_compose_remove_attachment({ name: attachment.filename })}
              onclick={() => removeAttachment(attachment.uploadId)}
            >
              <X size={16} />
            </Button>
          </li>
        {/each}
        {#each uploading as pending (pending)}
          <li
            class="border-cn-border text-text-muted flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm"
            role="status"
          >
            <span class="max-w-48 truncate font-bold">{pending.name}</span>
            <span class="text-xs">{m.mail_compose_uploading()}</span>
          </li>
        {/each}
        {#if draft.forwardedParts.length}
          <li class="text-text-muted px-1 py-1.5 text-sm">
            {m.mail_compose_forwarded_parts({ count: draft.forwardedParts.length })}
          </li>
        {/if}
      </ul>
    {/if}

    {#if failure}
      <p class="text-red-err px-4 pb-3 text-sm" role="alert">{mailErrorText(failure)}</p>
    {/if}
  </div>
</div>
