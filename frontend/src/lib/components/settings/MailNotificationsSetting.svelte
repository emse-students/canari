<script lang="ts">
  /**
   * "Notifications de nouveaux mails" (lot 4, docs/wiki/mail-client-transport.md#as-built---lot-4):
   * the account's switch on THIS device, off by default, drawn only where the Mail tab is (D10, D12).
   * Its hint says what it costs here: on Android a connection kept open and a notification that stays
   * shown, on an iPhone a check when the system allows, elsewhere while Canari is open.
   *
   * Turning it on asks the notification permission first - from this gesture, never from the
   * watcher - and a device that refuses keeps it off and says so.
   *
   * Lot 5: with the server's `mail_push = cloudflare` a phone gets its mail by an empty push, and the
   * hint says so; on Android a second switch keeps the persistent connection as well ("Connexion
   * permanente", off by default - no server at all, more battery).
   */
  import { Mail, Plug } from '@lucide/svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import { currentMailClient, mailTabVisible } from '$lib/mail/mailClient.svelte';
  import { askMailNotificationPermission } from '$lib/mail/mailNotify';
  import {
    mailNotificationsWanted,
    mailPersistentWanted,
    setMailNotificationsWanted,
    setMailPersistentWanted,
  } from '$lib/mail/mailWatchSwitch.svelte';
  import { serverMailPush } from '$lib/stores/appVersionCheck.svelte';
  import { m } from '$lib/paraglide/messages';
  import { isAndroidTauriRuntime, isIosTauriRuntime } from '$lib/utils/appVersion';
  import { Log } from '$lib/utils/Log';

  const client = $derived(mailTabVisible() ? currentMailClient() : null);
  const shown = $derived(client !== null && client.store.eligibility === 'eligible');
  const on = $derived(client ? mailNotificationsWanted(client.userId) : false);
  let busy = $state(false);
  let blocked = $state(false);

  const pushed = $derived(
    serverMailPush() === 'cloudflare' && (isAndroidTauriRuntime() || isIosTauriRuntime())
  );
  const persistentShown = $derived(on && pushed && isAndroidTauriRuntime());
  const persistentOn = $derived(client ? mailPersistentWanted(client.userId) : false);

  const hint = $derived(
    pushed
      ? m.mail_notif_setting_hint_push()
      : isAndroidTauriRuntime()
        ? m.mail_notif_setting_hint_android()
        : isIosTauriRuntime()
          ? m.mail_notif_setting_hint_ios()
          : m.mail_notif_setting_hint_open()
  );

  async function change(next: boolean) {
    if (!client || busy) return;
    const userId = client.userId;
    blocked = false;
    if (!next) {
      setMailNotificationsWanted(userId, false);
      return;
    }
    busy = true;
    try {
      if (!(await askMailNotificationPermission())) {
        Log.i('SETTINGS', 'new-mail notifications not turned on: the device refuses notifications');
        blocked = true;
        return;
      }
      setMailNotificationsWanted(userId, true);
    } finally {
      busy = false;
    }
  }
</script>

{#if shown}
  <div class="border-cn-border mt-6 space-y-3 border-t pt-6" data-mail-notifications>
    <Toggle
      layout="row"
      icon={Mail}
      checked={on}
      {busy}
      label={m.mail_notif_setting_label()}
      {hint}
      onchange={(next) => void change(next)}
    />
    {#if persistentShown && client}
      <Toggle
        layout="row"
        icon={Plug}
        checked={persistentOn}
        label={m.mail_persistent_setting_label()}
        hint={m.mail_persistent_setting_hint()}
        onchange={(next) => {
          Log.i('SETTINGS', `mail persistent connection -> ${next}`);
          setMailPersistentWanted(client.userId, next);
        }}
      />
    {/if}
    {#if blocked}
      <p class="text-text-muted text-xs font-medium" role="status">
        {m.mail_notif_setting_blocked()}
      </p>
    {/if}
  </div>
{/if}
