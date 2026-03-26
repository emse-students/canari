<script lang="ts">
  import { getToken } from '$lib/stores/auth';

  let isLoading = $state(false);
  let errorMessage = $state('');

  // Identifiant de l'association (récupéré via les props ou le store d'auth)
  let { data }: { data: any } = $props();
  let associationId = $derived(data?.associationId || 'asso-demo-123');

  async function connectStripe() {
    isLoading = true;
    errorMessage = '';
    try {
      let token = '';
      try {
        token = await getToken();
      } catch {
        // unauthenticated
      }
      const response = await fetch('/api/payments/onboarding', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ associationId }),
      });

      if (!response.ok) throw new Error('Erreur lors de la génération du lien');

      const { url } = await response.json();
      // Redirection vers le flux d'onboarding Stripe
      window.location.href = url;
    } catch (error: any) {
      errorMessage = error.message;
    } finally {
      isLoading = false;
    }
  }
</script>

<div class="px-4 py-6 sm:px-6 max-w-2xl mx-auto">
  <div class="rounded-2xl border border-cn-border bg-white/80 p-6">
    <h2 class="text-xl font-extrabold text-text-main tracking-tight mb-2">
      Caisse de l'association
    </h2>
    <p class="text-sm text-text-muted mb-6">
      Pour recevoir les paiements de vos billets directement sur le compte de l'association,
      veuillez configurer votre compte bancaire.
    </p>

    {#if errorMessage}
      <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-3 mb-4 text-sm">
        {errorMessage}
      </div>
    {/if}

    <button
      onclick={connectStripe}
      disabled={isLoading}
      class="rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors disabled:opacity-50"
    >
      {isLoading ? 'Redirection…' : 'Connecter mon compte bancaire (Stripe)'}
    </button>
  </div>
</div>
