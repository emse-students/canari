<script lang="ts">
  let { data }: { data: any } = $props(); // data passé par le load SvelteKit
  let eventId = $derived(data.eventId);

  let options = $state({
    isMemberBDE: false,
    wantsMeal: false,
  });

  let isProcessing = $state(false);
  let paymentError = $state('');

  async function handlePayment() {
    isProcessing = true;
    paymentError = '';

    try {
      const response = await fetch('/api/payments/create-checkout-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify({ eventId, options }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          result.message || "Une erreur est survenue lors de l'initialisation du paiement"
        );
      }

      // Redirection vers Stripe Hosted Checkout Page
      if (result.url) {
        window.location.href = result.url;
      }
    } catch (error: any) {
      paymentError = error.message;
    } finally {
      isProcessing = false;
    }
  }
</script>

<div class="max-w-md mx-auto mt-10 p-6 bg-white rounded shadow-lg">
  <h1 class="text-2xl font-bold mb-6">Acheter un billet</h1>

  <div class="space-y-4 mb-6">
    <label class="flex items-center space-x-2">
      <input type="checkbox" bind:checked={options.isMemberBDE} class="form-checkbox" />
      <span>Je suis adhérent du BDE (-2€)</span>
    </label>

    <label class="flex items-center space-x-2">
      <input type="checkbox" bind:checked={options.wantsMeal} class="form-checkbox" />
      <span>Ajouter le repas (+5€)</span>
    </label>
  </div>

  {#if paymentError}
    <div class="bg-red-50 text-red-600 p-3 rounded mb-4 text-sm">
      {paymentError}
    </div>
  {/if}

  <button
    onclick={handlePayment}
    disabled={isProcessing}
    class="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 px-4 rounded transition disabled:opacity-75"
  >
    {isProcessing ? 'Génération de la transaction...' : 'Aller au paiement sécurisé'}
  </button>
</div>
