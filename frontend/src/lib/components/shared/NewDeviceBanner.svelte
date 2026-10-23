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
  import { exactDate } from '$lib/utils/time';
  import { m } from '$lib/paraglide/messages';

  /**
   * The account owner's device notices, both built on this device (`deviceNotices.svelte.ts`):
   *
   * - "A new device was added to your account" (user decision 2026-10-22), from a signed commit this
   *   device merged: the device's name when the account gave it one, when this device learned of it,
   *   and a way to the device list, where a device that is not the user's is removed. It stays -
   *   across reloads - until "Got it" or the list is opened.
   * - "One of your devices can no longer join your conversations", for a device of this account
   *   this device refused for a changed key (`refusedDevices.ts`), with the one remedy: reset it.
   *   It stays until dismissed.
   */
  const notices = $derived(session.isLoggedIn ? pendingDeviceNotices() : []);
  const notice = $derived(notices[0]);
  const when = $derived(notice ? exactDate(new Date(notice.at).toISOString()) : '');
  const refused = $derived(session.isLoggedIn ? pendingRefusedDeviceNotices()[0] : undefined);
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
