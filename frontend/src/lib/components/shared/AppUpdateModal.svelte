<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import { Download } from '@lucide/svelte';
  import {
    dismissAppUpdatePrompt,
    getAppVersionCheck,
    isAppUpdateAvailable,
  } from '$lib/stores/appVersionCheck.svelte';
  import { isAndroidTauriRuntime, openLatestAppUpdate } from '$lib/utils/appVersion';
  import { isTauriRuntime } from '$lib/utils/openExternal';
  import { m } from '$lib/paraglide/messages';

  const show = $derived(isAppUpdateAvailable());
  const info = $derived(getAppVersionCheck());
  const isNative = $derived(isTauriRuntime());
  const isAndroid = $derived(isAndroidTauriRuntime());

  let updating = $state(false);

  async function handleUpdate() {
    updating = true;
    try {
      await openLatestAppUpdate(info?.serverVersion ?? null);
    } finally {
      updating = false;
    }
  }
</script>

<Modal
  open={show && info !== null}
  title={m.update_optional_title()}
  dismissible={false}
  maxWidth="max-w-lg"
  onClose={() => {}}
>
  <div class="space-y-4 text-sm text-text-muted leading-relaxed">
    <p>
      {m.update_available_intro_prefix()}
      <strong class="text-cn-dark">{info?.clientVersion}</strong>
      {#if info?.serverVersion}
        {m.update_server_version_prefix()}
        <strong class="text-cn-dark">{info.serverVersion}</strong>.
      {/if}
    </p>
    {#if isAndroid}
      <p>{m.update_android_instruction()}</p>
    {:else if isNative}
      <p>{m.update_native_instruction()}</p>
    {:else}
      <p>{m.update_web_instruction()}</p>
    {/if}
  </div>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-4 py-2 text-sm text-text-muted hover:bg-cn-bg transition-colors"
      disabled={updating}
      onclick={dismissAppUpdatePrompt}
    >
      {m.update_later_button()}
    </button>
    <button
      type="button"
      class="inline-flex items-center gap-2 rounded-lg bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-60 shadow-sm"
      disabled={updating}
      onclick={() => void handleUpdate()}
    >
      <Download size={16} />
      {updating
        ? m.update_opening_label()
        : isNative
          ? m.update_download_button()
          : m.update_reload_button()}
    </button>
  {/snippet}
</Modal>
