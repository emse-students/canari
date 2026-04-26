<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { devLogin, devRoutesEnabled } from '$lib/stores/auth';

  let status = 'Initialisation…';
  let errorMsg = '';

  async function clearMlsState(userId: string) {
    // Efface tout state MLS corrompu ou résiduel pour cet utilisateur,
    // ainsi que le PIN sauvegardé. Force une initialisation propre.
    const { removeMlsState } = await import('$lib/utils/hex');
    await removeMlsState(userId);
    await removeMlsState(`dev-${userId}`);
    localStorage.removeItem(`mls_device_id_${userId}`);
    localStorage.removeItem('canari_saved_pin');
    // Effacer aussi les clés avec anciens formats (dev-<userId>)
    localStorage.removeItem(`mls_device_id_dev-${userId}`);
  }

  onMount(async () => {
    const params = new URLSearchParams(window.location.search);
    const u = (params.get('u') || 'dev-user').trim().toLowerCase();

    try {
      if (!devRoutesEnabled()) {
        status = 'Les routes de développement sont désactivées (VITE_ENABLE_DEV_ROUTES=0)';
        return;
      }

      status = `Connexion en dev en tant que ${u}…`;
      // devLogin retourne le vrai userId (UUID) assigné par le backend
      const user = await devLogin(u);

      // Nettoyer le state MLS APRÈS login pour avoir le vrai userId (UUID),
      // pas juste le nom d'utilisateur passé dans l'URL.
      // C'est la clé du bug CBOR : mls_autosave_<UUID> était laissé corrompu.
      clearMlsState(user.id);
      clearMlsState(u); // aussi nettoyer avec le nom au cas où

      status = 'Connexion réussie — redirection…';
      setTimeout(() => goto('/'), 300);
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      status = 'Échec de la connexion : ' + errorMsg;
    }
  });
</script>

<svelte:head>
  <title>Dev login</title>
</svelte:head>

<main class="p-6 max-w-xl mx-auto">
  <h1 class="text-xl font-bold mb-4">Dev login</h1>
  <p>{status}</p>
  {#if errorMsg}
    <pre class="mt-4 text-sm text-red-600">{errorMsg}</pre>
  {/if}
  <p class="mt-4 text-sm text-text-muted">
    Utiliser <code>?u=identifiant</code> pour préciser l'utilisateur.
  </p>
</main>
