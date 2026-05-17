<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { CircleX } from '@lucide/svelte';

  const sessionId = $derived(page.url.searchParams.get('session_id'));
  let formId = $state<string | null>(null);

  onMount(async () => {
    if (!sessionId) return;
    try {
      const coreUrl = (import.meta as any).env?.VITE_CORE_URL?.trim() || '';
      const res = await fetch(`${coreUrl}/api/payments/cancel-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      if (data.ok) formId = data.formId ?? null;
    } catch {
      // Non-fatal — submission will remain pending and can be reused on next attempt
    }
  });
</script>

<svelte:head>
  <title>Paiement annulé</title>
</svelte:head>

<div class="min-h-screen flex items-center justify-center px-4">
  <div class="max-w-md w-full text-center space-y-6">
    <div class="flex justify-center">
      <div class="p-4 rounded-full bg-red-100">
        <CircleX size={48} class="text-red-500" />
      </div>
    </div>
    <div>
      <h1 class="text-2xl font-extrabold text-text-main tracking-tight">Paiement annulé</h1>
      <p class="text-text-muted mt-2">
        Votre paiement n'a pas été finalisé. Votre inscription n'a pas été confirmée.
      </p>
    </div>
    <a
      href={formId ? `/forms/${formId}` : '/forms'}
      class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-6 py-3 text-sm font-bold text-cn-dark shadow-sm transition-all hover:bg-cn-yellow-hover"
    >
      {formId ? 'Réessayer' : 'Retour aux formulaires'}
    </a>
  </div>
</div>
