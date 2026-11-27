<script lang="ts">
  /**
   * THE MAIL SCREENS ON AN INVENTED MAILBOX (dev only, `/dev/mail-preview?view=`).
   *
   * The real `MailScreen`, `MailClient`, session, API and store, over `DemoMailbox` (the tests'
   * `FakeZimbra` with invented content). `view` picks the state shown:
   * `inbox` (default), `thread` (a four-message conversation), `html` (an HTML mail, remote images
   * blocked), `compose`, `folders` (the drawer), `selection`, `signin`, `pending` (the school address
   * not handed yet), `error` (the mailbox answering a server error).
   */
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import MailScreen from '$lib/components/mail/MailScreen.svelte';
  import { MailClient } from '$lib/mail/mailClient.svelte';
  import { emptyMessage } from '$lib/mail/mailCompose';
  import type { MailComposeState } from '$lib/mail/mailView';
  import { ZimbraSoapClient } from '$lib/mail/soapClient';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';
  import { zimbraFault } from '../mailFakes';
  import { DEMO_ADDRESS, DemoMailbox } from './mailDemoMailbox';

  const view = page.url.searchParams.get('view') ?? 'inbox';
  const mailbox = new DemoMailbox();
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

  /** An in-memory storage: the preview never writes the real device's mail entries. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a storage double, never rendered
  const memory = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return memory.size;
    },
    clear: () => memory.clear(),
    getItem: (k) => memory.get(k) ?? null,
    key: (i) => [...memory.keys()][i] ?? null,
    removeItem: (k) => void memory.delete(k),
    setItem: (k, v) => void memory.set(k, v),
  };

  const client = new MailClient(
    new ZimbraSoapClient(mailbox.zimbra.openStream),
    {
      userId: 'preview',
      deviceKey: () => key,
      mailAddress: async () => (view === 'pending' ? null : DEMO_ADDRESS),
    },
    storage
  );

  let conversationId = $state<string | null>(
    view === 'thread' ? '702' : view === 'html' ? '701' : null
  );
  let drawerOpen = $state(view === 'folders');
  let compose = $state<MailComposeState | null>(null);
  let ready = $state(false);

  void (async () => {
    Log.d('MAIL-PREVIEW', `view ${view}`);
    await client.readEligibility();
    if (view !== 'signin' && view !== 'pending') {
      await client.session.signIn('demo', false);
      if (view === 'error') mailbox.failWith = zimbraFault('service.FAILURE');
    }
    if (view === 'compose') {
      compose = {
        title: m.mail_compose_new(),
        initial: {
          ...emptyMessage(),
          to: [{ address: 'leo.fictif@example.test', name: 'Léo Fictif' }],
          subject: 'Réunion projet jeudi',
          text: 'Salut Léo,\n\nJeudi 14 h à la bibliothèque, ça me va.\n\nCamille',
        },
      };
    }
    ready = true;
  })();

  // The selection: two rows ticked once the list has loaded.
  $effect(() => {
    if (view !== 'selection' || client.store.conversations.length < 3) return;
    untrack(() => {
      if (client.store.selected.length) return;
      client.store.toggle(client.store.conversations[0].id);
      client.store.toggle(client.store.conversations[2].id);
    });
  });
</script>

<div class="h-full" data-mail-preview={view}>
  {#if ready}
    <MailScreen
      {client}
      {conversationId}
      onNavigate={(id) => (conversationId = id)}
      bind:drawerOpen
      bind:compose
    />
  {/if}
</div>
