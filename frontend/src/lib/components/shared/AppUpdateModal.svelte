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
  title="Mise à jour requise"
  dismissible={false}
  maxWidth="max-w-lg"
  onClose={() => {}}
>
  <div class="space-y-4 text-sm text-text-muted leading-relaxed">
    <p>
      Une nouvelle version de Canari est disponible. Vous utilisez la version
      <strong class="text-cn-dark">{info?.clientVersion}</strong>
      {#if info?.serverVersion}
        ; la version actuelle du serveur est
        <strong class="text-cn-dark">{info.serverVersion}</strong>.
      {/if}
    </p>
    {#if isAndroid}
      <p>
        Le téléchargement de l’APK s’ouvrira dans votre navigateur ; installez-le ensuite pour
        mettre à jour l’application.
      </p>
    {:else if isNative}
      <p>
        Téléchargez et installez la dernière version depuis la page de release GitHub.
      </p>
    {:else}
      <p>Rechargez l’application pour utiliser la dernière version déployée.</p>
    {/if}
  </div>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-4 py-2 text-sm text-text-muted hover:bg-cn-bg transition-colors"
      disabled={updating}
      onclick={dismissAppUpdatePrompt}
    >
      Plus tard
    </button>
    <button
      type="button"
      class="inline-flex items-center gap-2 rounded-lg bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover disabled:opacity-60 shadow-sm"
      disabled={updating}
      onclick={() => void handleUpdate()}
    >
      <Download size={16} />
      {updating
        ? 'Ouverture…'
        : isNative
          ? 'Télécharger la mise à jour'
          : 'Recharger l’application'}
    </button>
  {/snippet}
</Modal>
