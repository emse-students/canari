<script lang="ts">
  let isLoading = $state(false);
  let errorMessage = $state('');

  // Identifiant de l'association (récupéré via les props ou le store d'auth)
  let { data }: { data: any } = $props();
  let associationId = $derived(data?.associationId || 'asso-demo-123');

  async function connectStripe() {
    isLoading = true;
    errorMessage = '';
    try {
      const response = await fetch('/api/payments/onboarding', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('canari_authToken')}`, // Adapté à votre auth
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

<div class="p-6 bg-white rounded-lg shadow-md">
  <h2 class="text-xl font-bold mb-4">Caisse de l'association</h2>
  <p class="mb-4">
    Pour recevoir les paiements de vos billets directement sur le compte de l'association, veuillez
    configurer votre compte bancaire.
  </p>

  {#if errorMessage}
    <p class="text-red-500 mb-4">{errorMessage}</p>
  {/if}

  <button
    onclick={connectStripe}
    disabled={isLoading}
    class="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
  >
    {isLoading ? 'Redirection...' : 'Connecter mon compte bancaire (Stripe)'}
  </button>
</div>
