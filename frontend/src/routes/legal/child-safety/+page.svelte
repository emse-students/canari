<script lang="ts">
  import { m } from '$lib/paraglide/messages';
</script>

<svelte:head>
  <title>{m.legal_child_safety_title()} - Canari</title>
</svelte:head>

<div
  class="min-h-dvh overflow-y-auto bg-transparent px-4 py-10 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]"
>
  <div
    class="mx-auto w-full max-w-2xl rounded-3xl border border-white/40 bg-white/20 p-8 shadow-2xl backdrop-blur-2xl dark:border-white/10 dark:bg-black/40 md:p-12"
  >
    <!-- En-tête -->
    <div class="mb-10 text-center">
      <button
        onclick={() => history.back()}
        class="mb-6 inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-main transition-colors"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="h-4 w-4"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fill-rule="evenodd"
            d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z"
            clip-rule="evenodd"
          />
        </svg>
        {m.common_back()}
      </button>
      <div
        class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#151B2C] shadow-lg"
      >
        <img src="/favicon.png" alt="Canari" class="h-8 w-8 object-contain" />
      </div>
      <h1 class="text-3xl font-bold text-text-main">{m.legal_child_safety_title()}</h1>
      <p class="mt-2 text-sm text-text-muted">{m.legal_child_safety_subtitle()}</p>
      <p class="mt-1 text-xs text-text-muted">Dernière mise à jour : 21/05/2026</p>
    </div>

    <div class="space-y-8 text-sm leading-relaxed text-text-main">
      <!-- Engagement principal -->
      <section>
        <div class="rounded-xl border border-red-500/30 bg-red-500/5 p-5">
          <p class="mb-2 font-bold text-red-400">Interdiction absolue</p>
          <p class="text-text-muted">
            L'application <strong>Canari</strong>, éditée par l'association <strong>Rootz</strong>,
            interdit strictement et sans exception toute forme d'abus et d'exploitation sexuels
            d'enfants (CSAE - Child Sexual Abuse and Exploitation), y compris :
          </p>
          <ul class="mt-3 ml-4 list-disc space-y-1 text-text-muted">
            <li>
              La production, le partage, la distribution ou la possession de matériel d'abus sexuel
              sur mineurs (CSAM)
            </li>
            <li>Tout contenu à caractère sexuel impliquant des personnes mineures</li>
            <li>La sollicitation sexuelle de mineurs (<em>grooming</em>)</li>
            <li>Tout comportement facilitant ou promouvant l'exploitation sexuelle d'enfants</li>
          </ul>
        </div>
      </section>

      <!-- Contexte -->
      <section>
        <h2 class="mb-3 text-lg font-bold text-text-main">Contexte et audience</h2>
        <p class="text-text-muted mb-3">
          Canari est une application de messagerie sécurisée réservée exclusivement aux membres de
          la communauté de l'École des Mines de Saint-Étienne (EMSE). L'accès est contrôlé par le
          portail d'authentification unique de l'École des Mines (OIDC), ce qui limite l'accès aux
          étudiants, enseignants et personnels de l'établissement.
        </p>
        <p class="text-text-muted">
          L'application n'est pas destinée aux mineurs. L'accès est conditionné à l'appartenance à
          la communauté EMSE, dont les membres sont majoritairement des adultes. Tout accès non
          autorisé est prohibé par les
          <a href="/legal/cgu" class="text-cn-yellow hover:underline"
            >{m.legal_cgu_link()}</a
          >.
        </p>
      </section>

      <!-- Mesures techniques -->
      <section>
        <h2 class="mb-3 text-lg font-bold text-text-main">Mesures de protection</h2>
        <ul class="space-y-2">
          {#each [["Contrôle d'accès", "L'accès à Canari est limité aux comptes authentifiés via le portail OIDC de l'EMSE. Aucun compte public ou anonyme n'est possible."], ['Chiffrement de bout en bout', 'Toutes les communications privées sont chiffrées via le protocole MLS (RFC 9420). Le serveur ne peut pas lire le contenu des messages.'], ['Modération', "L'association Rootz se réserve le droit de suspendre immédiatement tout compte et de supprimer tout contenu enfreignant ces normes."], ['Signalement aux autorités', 'Tout contenu CSAE détecté ou signalé sera immédiatement transmis aux autorités compétentes, conformément à la loi française.']] as [titre, desc], i (i)}
            <li class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
              <span class="font-semibold text-cn-yellow">{titre} - </span><span
                class="text-text-muted">{desc}</span
              >
            </li>
          {/each}
        </ul>
      </section>

      <!-- Signalement -->
      <section>
        <h2 class="mb-3 text-lg font-bold text-text-main">Signalement d'abus</h2>
        <p class="text-text-muted mb-3">
          Si vous observez ou suspectez la présence de contenu CSAE sur Canari, vous êtes fortement
          encouragé(e) à le signaler immédiatement :
        </p>
        <div class="rounded-xl border border-white/20 bg-white/10 p-4 dark:bg-white/5 space-y-2">
          <p>
            <strong>Email :</strong>
            <a href="mailto:bureau@rootz-emse.fr" class="text-cn-yellow hover:underline ml-1"
              >bureau@rootz-emse.fr</a
            >
          </p>
          <p class="text-text-muted text-xs">
            Objet recommandé : <em>" Signalement CSAE - Canari "</em>. Décrivez la situation,
            incluez toute information pertinente (date, contenu, utilisateur concerné si connu).
            Nous traiterons le signalement dans les meilleurs délais.
          </p>
        </div>
        <p class="mt-3 text-text-muted">
          Vous pouvez également signaler directement aux autorités françaises via le portail
          <a
            href="https://www.internet-signalement.gouv.fr"
            target="_blank"
            rel="noopener"
            class="text-cn-yellow hover:underline">internet-signalement.gouv.fr</a
          >
          ou contacter le <strong>3018</strong> (numéro national de prévention du cyberharcèlement).
        </p>
      </section>

      <!-- Conséquences -->
      <section>
        <h2 class="mb-3 text-lg font-bold text-text-main">Conséquences des violations</h2>
        <p class="text-text-muted">
          Tout utilisateur dont le compte est associé à du contenu CSAE ou à une exploitation
          sexuelle d'enfants verra son compte suspendu immédiatement et définitivement. Les faits
          seront signalés aux autorités judiciaires compétentes (Police Nationale, Parquet).
          L'association Rootz coopérera pleinement avec toute enquête officielle.
        </p>
      </section>
    </div>

    <!-- Footer -->
    <div class="mt-10 border-t border-white/20 pt-6 text-center text-xs text-text-muted">
      <p>{m.legal_footer_credits()}</p>
      <div class="mt-2 flex justify-center gap-4">
        <a href="/legal/cgu" class="text-cn-yellow hover:underline">{m.legal_cgu_link()}</a>
        <a href="/legal/privacy" class="text-cn-yellow hover:underline">{m.legal_privacy_link()}</a>
      </div>
    </div>
  </div>
</div>
