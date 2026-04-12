<script lang="ts">
  import { page } from '$app/state';
  import { CircleCheck } from 'lucide-svelte';

  const sessionId = $derived(page.url.searchParams.get('session_id'));
</script>

<svelte:head>
  <title>Paiement réussi</title>
</svelte:head>

<div class="min-h-screen flex items-center justify-center px-4">
  <div class="max-w-md w-full text-center space-y-6">
    <div class="flex justify-center">
      <div class="p-4 rounded-full bg-green-100">
        <CircleCheck size={48} class="text-green-600" />
      </div>
    </div>
    <div>
      <h1 class="text-2xl font-extrabold text-text-main tracking-tight">Paiement confirmé !</h1>
      <p class="text-text-muted mt-2">
        Votre inscription a bien été enregistrée. Vous recevrez une confirmation par email.
      </p>
    </div>
    {#if sessionId}
      <p class="text-xs text-text-muted font-mono bg-cn-border/20 rounded-xl px-3 py-2 break-all">
        Référence : {sessionId}
      </p>
    {/if}
    <a
      href="/forms"
      class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-6 py-3 text-sm font-bold text-cn-dark shadow-sm transition-all hover:bg-cn-yellow-hover"
    >
      Retour aux formulaires
    </a>
  </div>
</div>
