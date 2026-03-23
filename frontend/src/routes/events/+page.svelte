<script lang="ts">
  import { goto } from '$app/navigation';
</script>

<div class="p-6 max-w-4xl mx-auto space-y-8">
  <h1 class="text-3xl font-bold">Événements (Démo)</h1>

  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
    <!-- Exemple 1 -->
    <div class="bg-white rounded-lg shadow-md p-6 border border-gray-100">
      <div class="text-xs font-bold text-blue-600 mb-2 uppercase tracking-wide">Soirée</div>
      <h3 class="text-xl font-bold mb-2">Gala de fin d'année</h3>
      <p class="text-gray-600 mb-4 line-clamp-3">
        La soirée la plus attendue de l'année. Tenue de soirée exigée.
      </p>

      <div class="flex items-center justify-between mt-auto pt-4 border-t border-gray-100">
        <span class="font-bold text-lg">25,00 €</span>
        <button
          class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-full text-sm font-medium transition-colors"
          onclick={() => goto('/events/evt-gala-2026/buy')}
        >
          Réserver
        </button>
      </div>
    </div>

    <!-- Exemple 2 -->
    <div class="bg-white rounded-lg shadow-md p-6 border border-gray-100">
      <div class="text-xs font-bold text-green-600 mb-2 uppercase tracking-wide">Sortie</div>
      <h3 class="text-xl font-bold mb-2">Week-end Ski</h3>
      <p class="text-gray-600 mb-4 line-clamp-3">
        Départ vendredi 18h, retour dimanche 20h. Forfait et logement inclus.
      </p>

      <div class="flex items-center justify-between mt-auto pt-4 border-t border-gray-100">
        <span class="font-bold text-lg">150,00 €</span>
        <button
          class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-full text-sm font-medium transition-colors"
          onclick={() => goto('/events/evt-ski-2026/buy')}
        >
          Réserver
        </button>
      </div>
    </div>

    <!-- Exemple 3 -->
    <div class="bg-white rounded-lg shadow-md p-6 border border-gray-100 opacity-60">
      <div class="text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Passé</div>
      <h3 class="text-xl font-bold mb-2">Afterwork BDE</h3>
      <p class="text-gray-600 mb-4">Rendez-vous au foyer pour décompresser après les partiels.</p>

      <div class="flex items-center justify-between mt-auto pt-4 border-t border-gray-100">
        <span class="font-bold text-lg">Gratuit</span>
        <button
          disabled
          class="bg-gray-200 text-gray-500 px-4 py-2 rounded-full text-sm font-medium cursor-not-allowed"
        >
          Terminé
        </button>
      </div>
    </div>
  </div>
</div>
