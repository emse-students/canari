<script lang="ts">
  /**
   * `/mail` and `/mail/<conversation>`: the Mail tab (docs/wiki/mail-client.md D10). ONE route with
   * an optional segment, so opening a conversation and going back reuses the screen and its list
   * (the list is not reloaded); the conversation is a place - Back closes it, a reload keeps it.
   *
   * Reachable only through the tab, which is shown when the server's switch is on (D12) and the
   * account's address is eligible (D1). A typed address with the switch off or an ineligible account
   * says so instead of drawing a mailbox.
   */
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { MailX } from '@lucide/svelte';
  import MailScreen from '$lib/components/mail/MailScreen.svelte';
  import MailStatePanel from '$lib/components/mail/MailStatePanel.svelte';
  import { currentMailClient, watchMailTab } from '$lib/mail/mailClient.svelte';
  import { mailErrorText } from '$lib/mail/mailErrorText';
  import { m } from '$lib/paraglide/messages';
  import { serverMailMode } from '$lib/stores/appVersionCheck.svelte';
  import { currentUserId } from '$lib/stores/userState.svelte';
  import { internalPath } from '$lib/utils/internalPath';
  import { Log } from '$lib/utils/Log';

  watchMailTab();

  const userId = $derived(currentUserId());
  const on = $derived(serverMailMode() === 'on');
  /** Built by the tab's watch for the account signed in (`watchMailTab`), never here. */
  const client = $derived.by(() => {
    const built = currentMailClient();
    return on && built && built.userId === userId ? built : null;
  });
  const conversationId = $derived(page.params.conversationId ?? null);

  function navigate(id: string | null) {
    Log.d('MAIL-UI', id ? 'open a conversation' : 'back to the list');
    void goto(resolve(internalPath(id ? `/mail/${encodeURIComponent(id)}` : '/mail')));
  }
</script>

<div class="h-full" data-mail-route>
  {#if !on}
    <MailStatePanel Icon={MailX} title={m.mail_not_open_yet()} />
  {:else if client && client.store.eligibility === 'not_eligible'}
    <MailStatePanel Icon={MailX} title={mailErrorText('not_eligible')} />
  {:else if client}
    <MailScreen {client} {conversationId} onNavigate={navigate} />
  {/if}
</div>
