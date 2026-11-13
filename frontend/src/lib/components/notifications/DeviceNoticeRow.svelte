<script lang="ts">
  import { MonitorSmartphone } from '@lucide/svelte';
  import { resolve } from '$app/paths';
  import { dismissDeviceNotice, type OwnDeviceNotice } from '$lib/utils/chat/deviceNotices.svelte';
  import { revokeNoticedDevice } from '$lib/utils/chat/deviceNoticeWiring';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { exactDate } from '$lib/utils/time';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The alert, built on this device from a signed commit (`deviceNotices.svelte.ts`). */
    notice: OwnDeviceNotice;
    /** Draw the amber dot: unread when the list opened (the live flag clears at once). */
    unread: boolean;
  }

  let { notice, unread }: Props = $props();

  /**
   * "A new device was added to your account" as a row of the notification list (owner decision
   * 2026-10-30, replacing the app-wide banner): the device's name when the account gave it one,
   * when this device learned of it, a way to the device list, "Not me" - which revokes the device at
   * once, its logins ending and its leaf leaving every conversation - and "Got it". It stays, across
   * reloads, until one of those, and it is a LOCAL entry: never sent to the server, never a push.
   */
  const when = $derived(exactDate(new Date(notice.at).toISOString()));
  let revoking = $state(false);

  /** "Not me": confirmed, then the device is revoked; the row leaves only if that succeeded. */
  async function notMe() {
    const confirmed = await showConfirm(
      m.chat_delete_device_confirm({ name: notice.label ?? notice.deviceId.slice(0, 8) }),
      { danger: true, confirmLabel: m.common_delete_button() }
    );
    if (!confirmed) return;
    revoking = true;
    try {
      if (await revokeNoticedDevice(notice.deviceId)) {
        dismissDeviceNotice(notice.key);
        showToast(m.device_notice_not_me_done(), 'info');
      } else {
        showToast(m.device_notice_not_me_failed(), 'error');
      }
    } finally {
      revoking = false;
    }
  }
</script>

<!-- The geometry of `NotificationRow`: a 56px disc with its badge, a sentence, the amber dot. -->
<div
  class="flex w-full items-start gap-3 rounded-lg px-2 py-2.5"
  data-device-notice
  data-device-notice-key={notice.key}
>
  <span
    class="bg-cn-border/60 text-text-main flex h-14 w-14 shrink-0 items-center justify-center rounded-full"
    aria-hidden="true"
  >
    <MonitorSmartphone size={24} />
  </span>
  <div class="min-w-0 flex-1">
    <p class="text-sm font-semibold {unread ? 'text-text-main' : 'text-text-muted'}">
      {m.device_notice_title()}
    </p>
    <p class="text-text-muted mt-0.5 text-sm leading-snug">
      {notice.label
        ? m.device_notice_body_named({ label: notice.label, when })
        : m.device_notice_body({ when })}
      {m.device_notice_hint()}
    </p>
    <div class="mt-1 flex flex-wrap items-center gap-2 text-sm">
      <a
        href={resolve('/settings/[section]', { section: 'security' })}
        class="bg-cn-surface-alt text-text-main hover:bg-accent/30 inline-flex min-h-11 items-center rounded-full px-4 font-semibold"
        onclick={() => dismissDeviceNotice(notice.key)}>{m.device_notice_view()}</a
      >
      <button
        type="button"
        class="bg-cn-surface-alt text-text-main hover:bg-accent/30 inline-flex min-h-11 items-center rounded-full px-4 font-semibold disabled:opacity-50"
        disabled={revoking}
        data-device-notice-not-me
        onclick={notMe}>{m.device_notice_not_me()}</button
      >
      <button
        type="button"
        class="bg-cn-surface-alt text-text-muted inline-flex min-h-11 items-center rounded-full px-4 font-semibold"
        data-device-notice-dismiss
        onclick={() => dismissDeviceNotice(notice.key)}>{m.device_notice_dismiss()}</button
      >
    </div>
  </div>
  {#if unread}
    <span class="bg-accent mt-2 h-2.5 w-2.5 shrink-0 rounded-full" aria-hidden="true"></span>
  {/if}
</div>
