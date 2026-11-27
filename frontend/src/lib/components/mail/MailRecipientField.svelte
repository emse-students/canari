<script lang="ts">
  /**
   * ONE RECIPIENT LINE OF THE COMPOSER (mockup "Nouveau message"): the addresses as chips, a field
   * to type one, and the school directory's suggestions under it (`MailApi.directory`, Zimbra's
   * autocomplete with the GAL).
   *
   * Every keystroke may ask the directory; an answer is applied only if it answers the text STILL
   * typed (a counter of requests, never a timer), so a slow answer for "le" never replaces the one
   * for "leca". Enter, a comma or a semicolon turns the text into a chip when it is an address.
   */
  import { X } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import AvatarPlaceholder from '$lib/components/shared/AvatarPlaceholder.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { MailApi } from '$lib/mail/mailApi';
  import { classifyMailFailure } from '$lib/mail/mailErrors';
  import { displayNameOf } from '$lib/mail/mailFormat';
  import type { DirectoryMatch, MailAddress } from '$lib/mail/mailTypes';
  import { parseMailbox } from '$lib/mail/zimbraParse';
  import { getInitials } from '$lib/utils/avatar';
  import { Log } from '$lib/utils/Log';

  interface Props {
    /** The visible label ("À", "Cc", "Cci"). */
    label: string;
    id: string;
    recipients: MailAddress[];
    api: Pick<MailApi, 'directory'>;
  }

  let { label, id, recipients = $bindable(), api }: Props = $props();

  let text = $state('');
  let suggestions = $state<DirectoryMatch[]>([]);
  let asked = 0;

  /** The shortest text the directory is asked about. */
  const MIN_QUERY = 2;

  async function ask(value: string) {
    const ticket = ++asked;
    if (value.trim().length < MIN_QUERY) {
      suggestions = [];
      return;
    }
    try {
      const found = await api.directory(value);
      if (ticket !== asked) return;
      const chosen = new Set(recipients.map((r) => r.address.toLowerCase()));
      suggestions = found.filter((s) => !chosen.has(s.address.toLowerCase())).slice(0, 6);
    } catch (err) {
      if (ticket !== asked) return;
      suggestions = [];
      Log.w('MAIL-UI', `the directory did not answer (${classifyMailFailure(err).kind})`);
    }
  }

  function add(address: MailAddress) {
    const key = address.address.toLowerCase();
    if (!recipients.some((r) => r.address.toLowerCase() === key)) {
      recipients = [...recipients, address];
    }
    text = '';
    suggestions = [];
    asked++;
  }

  function commitText(): boolean {
    const mailbox = parseMailbox(text.replace(/[,;]\s*$/, ''));
    if (!mailbox) return false;
    add(mailbox);
    return true;
  }

  function remove(address: string) {
    recipients = recipients.filter((r) => r.address !== address);
  }

  function onkeydown(event: KeyboardEvent) {
    if ((event.key === 'Enter' || event.key === ',' || event.key === ';') && text.trim()) {
      event.preventDefault();
      if (!commitText() && suggestions[0]) add(suggestions[0]);
    } else if (event.key === 'Backspace' && !text && recipients.length) {
      recipients = recipients.slice(0, -1);
    }
  }

  /** The typed text, committed when the field is left with an address in it. */
  function onblur() {
    if (text.trim()) commitText();
  }
</script>

<div class="border-cn-border flex flex-col border-b" data-mail-recipients={id}>
  <div class="flex flex-wrap items-center gap-1.5 px-4 py-1.5">
    <label for={id} class="text-text-muted w-10 shrink-0 text-sm font-semibold">{label}</label>
    {#each recipients as recipient (recipient.address)}
      <span
        class="bg-cn-surface-alt text-text-main flex items-center gap-1.5 rounded-full py-0.5 pr-1 pl-0.5 text-sm font-semibold"
        data-mail-chip
      >
        <AvatarPlaceholder
          seed={recipient.address}
          initials={getInitials(displayNameOf(recipient))}
          class="text-2xs h-6 w-6 rounded-full"
        />
        <span class="max-w-48 truncate" title={recipient.address}>{displayNameOf(recipient)}</span>
        <Button
          variant="bare"
          class="text-text-muted hover:text-text-main rounded-full p-0.5"
          aria-label={m.mail_recipient_remove({ name: displayNameOf(recipient) })}
          onclick={() => remove(recipient.address)}
        >
          <X size={14} />
        </Button>
      </span>
    {/each}
    <Input
      {id}
      type="email"
      bind:value={text}
      density="compact"
      class="min-w-32 flex-1 [&_input]:border-transparent [&_input]:bg-transparent"
      autocomplete="off"
      oninput={(e) => void ask(e.currentTarget.value)}
      {onkeydown}
      {onblur}
      role="combobox"
      aria-expanded={suggestions.length > 0}
      aria-controls="{id}-suggestions"
      aria-autocomplete="list"
    />
  </div>
  {#if suggestions.length}
    <ul
      id="{id}-suggestions"
      role="listbox"
      aria-label={m.mail_directory_label()}
      class="bg-cn-surface flex flex-col pb-1"
    >
      <li class="text-text-muted px-4 py-1 text-xs font-bold" role="presentation">
        {m.mail_directory_title()}
      </li>
      {#each suggestions as suggestion (suggestion.address)}
        <li role="option" aria-selected="false">
          <Button
            variant="bare"
            class="hover:bg-cn-surface-alt flex w-full items-center gap-3 px-4 py-2 text-left"
            onclick={() => add(suggestion)}
          >
            <AvatarPlaceholder
              seed={suggestion.address}
              initials={getInitials(displayNameOf(suggestion))}
              class="h-8 w-8 shrink-0 rounded-full text-xs"
            />
            <span class="flex min-w-0 flex-col">
              <span class="text-text-main truncate text-sm font-bold"
                >{displayNameOf(suggestion)}</span
              >
              <span class="text-text-muted truncate text-xs">{suggestion.address}</span>
            </span>
          </Button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
