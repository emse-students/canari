<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
</script>

<main class="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
  <p class="text-2xl font-bold text-text-main">{page.status}</p>
  <p class="text-text-muted">{page.error?.message ?? 'Une erreur inattendue est survenue.'}</p>
  <button
    class="mt-2 px-4 py-2 rounded-xl bg-cn-yellow text-cn-dark font-semibold text-sm"
    onclick={() => goto('/login', { replaceState: true })}
  >
    Retour à l'accueil
  </button>
</main>
