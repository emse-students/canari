<script lang="ts">
  import { goto } from '$app/navigation';
</script>

<div class="px-4 py-6 sm:px-6 max-w-4xl mx-auto">
  <h1 class="text-2xl font-extrabold text-text-main tracking-tight mb-6">Événements (Démo)</h1>

  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
    <!-- Exemple 1 -->
    <div class="rounded-2xl border border-cn-border bg-white/80 p-5 flex flex-col">
      <div class="text-xs font-bold text-cn-dark mb-2 uppercase tracking-wide">Soirée</div>
      <h3 class="text-lg font-bold text-text-main mb-2">Gala de fin d'année</h3>
      <p class="text-sm text-text-muted mb-4 line-clamp-3 flex-1">
        La soirée la plus attendue de l'année. Tenue de soirée exigée.
      </p>
      <div class="flex items-center justify-between pt-3 border-t border-cn-border">
        <span class="font-bold text-text-main">25,00 €</span>
        <button
          class="rounded-xl bg-cn-yellow px-3 py-1.5 text-xs font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors"
          onclick={() => goto('/events/evt-gala-2026/buy')}
        >
          Réserver
        </button>
      </div>
    </div>

    <!-- Exemple 2 -->
    <div class="rounded-2xl border border-cn-border bg-white/80 p-5 flex flex-col">
      <div class="text-xs font-bold text-cn-dark mb-2 uppercase tracking-wide">Sortie</div>
      <h3 class="text-lg font-bold text-text-main mb-2">Week-end Ski</h3>
      <p class="text-sm text-text-muted mb-4 line-clamp-3 flex-1">
        Départ vendredi 18h, retour dimanche 20h. Forfait et logement inclus.
      </p>
      <div class="flex items-center justify-between pt-3 border-t border-cn-border">
        <span class="font-bold text-text-main">150,00 €</span>
        <button
          class="rounded-xl bg-cn-yellow px-3 py-1.5 text-xs font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors"
          onclick={() => goto('/events/evt-ski-2026/buy')}
        >
          Réserver
        </button>
      </div>
    </div>

    <!-- Exemple 3 -->
    <div class="rounded-2xl border border-cn-border bg-white/40 p-5 flex flex-col opacity-60">
      <div class="text-xs font-bold text-text-muted mb-2 uppercase tracking-wide">Passé</div>
      <h3 class="text-lg font-bold text-text-main mb-2">Afterwork BDE</h3>
      <p class="text-sm text-text-muted mb-4 flex-1">
        Rendez-vous au foyer pour décompresser après les partiels.
      </p>
      <div class="flex items-center justify-between pt-3 border-t border-cn-border">
        <span class="font-bold text-text-main">Gratuit</span>
        <button
          disabled
          class="rounded-xl bg-cn-surface border border-cn-border px-3 py-1.5 text-xs font-bold text-text-muted cursor-not-allowed"
        >
          Terminé
        </button>
      </div>
    </div>
  </div>
</div>
