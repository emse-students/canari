<script lang="ts">
  /**
   * "ENVOYER L'HISTORIQUE DES MESSAGES" - the start date of a history grant (owner, 2026-11-25).
   *
   * Four shortcuts (24 h, 7 days, 30 days, everything) and a calendar date; the send itself is the
   * caller's (`grantHistoryToNewcomer`). A date in the future is refused here rather than turned
   * into one: there is nothing to send from it. The mechanism and its decisions:
   * docs/wiki/protocols/history-reconciliation.md#a-member-may-send-their-history-to-a-newcomer-owner-2026-11-25.
   */
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import { m } from '$lib/paraglide/messages';
  import { grantSinceFor, grantSinceForDate, type GrantPreset } from '$lib/utils/chat/historyGrant';
  import { Log } from '$lib/utils/Log';

  interface Props {
    /** The newcomer's display name. */
    name: string;
    onClose: () => void;
    /** Sends the grant from `since` (server-clock ms, `0` = everything); throws when it could not. */
    onSend: (since: number) => Promise<void>;
  }

  let { name, onClose, onSend }: Props = $props();

  type Choice = GrantPreset | 'date';
  const choices: { key: Choice; label: () => string }[] = [
    { key: '24h', label: () => m.chat_history_grant_24h() },
    { key: '7d', label: () => m.chat_history_grant_7d() },
    { key: '30d', label: () => m.chat_history_grant_30d() },
    { key: 'everything', label: () => m.chat_history_grant_everything() },
    { key: 'date', label: () => m.chat_history_grant_date() },
  ];

  let choice = $state<Choice>('7d');
  let date = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function send() {
    const now = Date.now();
    const since = choice === 'date' ? grantSinceForDate(date, now) : grantSinceFor(choice, now);
    if (since === null) {
      Log.d('HISTORY_GRANT', `picked date "${date}" refused - not a past date`);
      error = m.chat_history_grant_bad_date();
      return;
    }
    Log.i('HISTORY_GRANT', `grant confirmed: ${choice}`);
    busy = true;
    error = null;
    try {
      await onSend(since);
    } catch (e) {
      console.error(`[HISTORY_GRANT] the grant was not sent:`, e);
      error = m.chat_history_grant_failed();
    } finally {
      busy = false;
    }
  }
</script>

<Modal
  open
  title={m.chat_history_grant_title({ name })}
  dismissible={!busy}
  onClose={() => !busy && onClose()}
>
  <div class="space-y-4" data-testid="history-grant-dialog">
    <p class="text-text-muted text-sm">{m.chat_history_grant_description({ name })}</p>
    <fieldset class="space-y-2">
      {#each choices as c (c.key)}
        <label class="text-text-main flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="history-grant-since"
            value={c.key}
            checked={choice === c.key}
            onchange={() => {
              choice = c.key;
              error = null;
            }}
          />
          {c.label()}
        </label>
      {/each}
    </fieldset>
    {#if choice === 'date'}
      <Input type="date" bind:value={date} label={m.chat_history_grant_date()} />
    {/if}
    {#if error}
      <p role="alert" class="text-red-err text-sm">{error}</p>
    {/if}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" disabled={busy} onclick={onClose}>
        {m.chat_history_grant_cancel()}
      </Button>
      <Button disabled={busy} onclick={() => void send()} data-testid="history-grant-send">
        {m.chat_history_grant_send()}
      </Button>
    </div>
  </div>
</Modal>
