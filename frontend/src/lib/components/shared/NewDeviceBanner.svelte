<script lang="ts">
  import { MonitorSmartphone, ShieldAlert } from '@lucide/svelte';
  import Banner from './Banner.svelte';
  import { globalSession as session } from '$lib/stores/globalChatSingleton.svelte';
  import {
    dismissDeviceNotice,
    dismissRefusedDeviceNotice,
    pendingDeviceNotices,
    pendingRefusedDeviceNotices,
  } from '$lib/utils/chat/deviceNotices.svelte';
  import { revokeNoticedDevice } from '$lib/utils/chat/deviceNoticeWiring';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { exactDate } from '$lib/utils/time';
  import { m } from '$lib/paraglide/messages';

  /**
   * The account owner's device notices, both built on this device (`deviceNotices.svelte.ts`):
   *
   * - "A new device was added to your account" (user decision 2026-10-22), from a signed commit this
   *   device merged: the device's name when the account gave it one, when this device learned of it,
   *   a way to the device list, and "Not me", which revokes the device at once - its logins end and
   *   its leaf leaves every conversation (`revokeNoticedDevice`). It stays - across reloads - until
   *   "Got it", the list is opened, or the device is revoked.
   * - "One of your devices can no longer join your conversations", for a device of this account
   *   this device refused for a changed key (`refusedDevices.ts`), with the one remedy: reset it.
   *   It stays until dismissed.
   */
  const notices = $derived(session.isLoggedIn ? pendingDeviceNotices() : []);
  const notice = $derived(notices[0]);
  const when = $derived(notice ? exactDate(new Date(notice.at).toISOString()) : '');
  const refused = $derived(session.isLoggedIn ? pendingRefusedDeviceNotices()[0] : undefined);
  let revoking = $state(false);

  /** "Not me": confirmed, then the device is revoked; the alert leaves only if that succeeded. */
  async function notMe(target: { key: string; deviceId: string; label?: string }) {
    const confirmed = await showConfirm(
      m.chat_delete_device_confirm({ name: target.label ?? target.deviceId.slice(0, 8) }),
      { danger: true, confirmLabel: m.common_delete_button() }
    );
    if (!confirmed) return;
    revoking = true;
    try {
      if (await revokeNoticedDevice(target.deviceId)) {
        dismissDeviceNotice(target.key);
        showToast(m.device_notice_not_me_done(), 'info');
      } else {
        showToast(m.device_notice_not_me_failed(), 'error');
      }
    } finally {
      revoking = false;
    }
  }
</script>

{#if notice}
  <Banner variant="info" tone="alert">
    <MonitorSmartphone size={15} class="shrink-0" aria-hidden="true" />
    <div class="flex min-w-0 flex-col">
      <strong>{m.device_notice_title()}</strong>
      <span>
        {notice.label
          ? m.device_notice_body_named({ label: notice.label, when })
          : m.device_notice_body({ when })}
        {m.device_notice_hint()}
      </span>
    </div>
    {#snippet action()}
      <div class="flex shrink-0 items-center gap-2">
        <a
          href="/settings/security"
          class="font-semibold underline"
          onclick={() => dismissDeviceNotice(notice.key)}>{m.device_notice_view()}</a
        >
        <button
          type="button"
          class="font-semibold"
          disabled={revoking}
          data-device-notice-not-me
          onclick={() => notMe(notice)}>{m.device_notice_not_me()}</button
        >
        <button type="button" class="font-semibold" onclick={() => dismissDeviceNotice(notice.key)}
          >{m.device_notice_dismiss()}</button
        >
      </div>
    {/snippet}
  </Banner>
{/if}

{#if refused}
  <Banner variant="info" tone="alert">
    <ShieldAlert size={15} class="shrink-0" aria-hidden="true" />
    <div class="flex min-w-0 flex-col">
      <strong>{m.device_refused_title()}</strong>
      <span>
        {refused.label
          ? m.device_refused_body_named({ label: refused.label })
          : m.device_refused_body()}
        {m.device_refused_remedy()}
      </span>
    </div>
    {#snippet action()}
      <div class="flex shrink-0 items-center gap-2">
        <a href="/settings/security" class="font-semibold underline">{m.device_notice_view()}</a>
        <button
          type="button"
          class="font-semibold"
          onclick={() => dismissRefusedDeviceNotice(refused.identity)}
          >{m.device_notice_dismiss()}</button
        >
      </div>
    {/snippet}
  </Banner>
{/if}
