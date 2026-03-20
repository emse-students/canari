<script lang="ts">
  import { APP_PLACES } from '$lib/navigation/places';

  const roadmap = APP_PLACES.filter((place) => place.id !== 'communities');
</script>

<main class="h-full overflow-y-auto px-4 py-6 md:px-8 md:py-8">
  <section class="mx-auto max-w-5xl space-y-6 animate-rise-in">
    <header class="rounded-3xl border border-cn-border bg-white/70 p-6 backdrop-blur-md">
      <p class="text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">Lieu actif</p>
      <h1 class="mt-2 text-3xl font-black tracking-tight text-text-main">Communautes</h1>
      <p class="mt-3 max-w-2xl text-sm text-text-muted">
        Cette page centralisera la gestion des espaces, des roles globaux (admin/moderateur/membre),
        des permissions et des futurs salons vocaux.
      </p>
    </header>

    <section class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <article class="rounded-2xl border border-cn-border bg-[color-mix(in_srgb,var(--cn-surface)_86%,white)] p-5">
        <h2 class="text-base font-bold text-text-main">Ce qui est deja disponible</h2>
        <ul class="mt-3 space-y-2 text-sm text-text-main">
          <li>Creation de communautes depuis le chat</li>
          <li>Creation de canaux dans une communaute</li>
          <li>Invitation des membres avec role</li>
          <li>Mise a jour du role d'un membre (canal)</li>
        </ul>
      </article>

      <article class="rounded-2xl border border-cn-border bg-[color-mix(in_srgb,var(--cn-surface)_86%,white)] p-5">
        <h2 class="text-base font-bold text-text-main">Prochaines briques</h2>
        <ul class="mt-3 space-y-2 text-sm text-text-main">
          <li>Panneau permissions globales par communaute</li>
          <li>Heritage des permissions vers les canaux</li>
          <li>Gestion fine des invitations et exclusions</li>
          <li>Salons vocaux avec presence et moderation</li>
        </ul>
      </article>
    </section>

    <section class="rounded-2xl border border-cn-border bg-white/70 p-5">
      <h2 class="text-base font-bold text-text-main">Autres lieux du produit</h2>
      <div class="mt-3 space-y-2">
        {#each roadmap as place (place.id)}
          <div class="flex items-center justify-between rounded-xl border border-cn-border bg-white/70 px-3 py-2 text-sm">
            <span class="font-semibold text-text-main">{place.label}</span>
            <span class="text-xs text-text-muted">{place.description}</span>
          </div>
        {/each}
      </div>
    </section>
  </section>
</main>
