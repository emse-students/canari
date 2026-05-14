<script lang="ts">
  import { goto } from '$app/navigation';
</script>

<svelte:head>
  <title>Conditions Générales d'Utilisation — Canari</title>
</svelte:head>

<div class="min-h-dvh overflow-y-auto bg-transparent px-4 py-10 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]">
  <div class="mx-auto w-full max-w-2xl rounded-3xl border border-white/40 bg-white/20 p-8 shadow-2xl backdrop-blur-2xl dark:border-white/10 dark:bg-black/40 md:p-12">

    <!-- En-tête -->
    <div class="mb-10 text-center">
      <button
        onclick={() => goto(-1 as never)}
        class="mb-6 inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-main transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clip-rule="evenodd" />
        </svg>
        Retour
      </button>
      <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#151B2C] shadow-lg">
        <img src="/favicon.png" alt="Canari" class="h-8 w-8 object-contain" />
      </div>
      <h1 class="text-3xl font-bold text-text-main">Conditions Générales d'Utilisation</h1>
      <p class="mt-2 text-sm text-text-muted">Canari — Messagerie sécurisée EMSE</p>
      <p class="mt-1 text-xs text-text-muted">Dernière mise à jour : 14/05/2026</p>
    </div>

    <!-- Navigation rapide -->
    <nav class="mb-8 rounded-2xl border border-white/30 bg-white/10 p-4 dark:border-white/10 dark:bg-white/5">
      <p class="mb-2 text-xs font-semibold uppercase tracking-widest text-text-muted">Sommaire</p>
      <ul class="space-y-1 text-sm text-cn-yellow">
        {#each [
          ['#definitions', '1. Définitions'],
          ['#acces', '2. Accès et hébergement'],
          ['#chiffrement', '3. Chiffrement et sécurité'],
          ['#utilisation', '4. Règles d\'utilisation'],
          ['#contenu', '5. Contenu et publications'],
          ['#donnees', '6. Données personnelles'],
          ['#propriete', '7. Propriété intellectuelle'],
          ['#responsabilite', '8. Responsabilité'],
          ['#contact', '9. Contact'],
        ] as [href, label], i (i)}
          <li><a {href} class="hover:underline">{label}</a></li>
        {/each}
      </ul>
    </nav>

    <div class="space-y-8 text-sm leading-relaxed text-text-main">

      <!-- 1 -->
      <section id="definitions">
        <h2 class="mb-3 text-lg font-bold text-text-main">1. Définitions</h2>
        <p class="mb-3">Pour la bonne compréhension des présentes conditions :</p>
        <ul class="space-y-2">
          {#each [
            ['Le Service', 'L\'application Canari (mobile Android, bureau Windows/macOS/Linux, web) et son infrastructure backend.'],
            ['L\'Éditeur', 'L\'association étudiante Rootz, affiliée à l\'École des Mines de Saint-Étienne.'],
            ['L\'Utilisateur', 'Toute personne disposant d\'un compte valide lié à l\'École des Mines de Saint-Étienne (EMSE).'],
            ['MLS', 'Messaging Layer Security (RFC 9420) — protocole de chiffrement de bout en bout utilisé pour les messages privés.'],
            ['Association', 'Groupe ou organisation étudiante créé au sein de la plateforme.'],
          ] as [terme, def], i (i)}
            <li class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
              <span class="font-semibold text-cn-yellow">{terme} — </span><span class="text-text-muted">{def}</span>
            </li>
          {/each}
        </ul>
      </section>

      <!-- 2 -->
      <section id="acces">
        <h2 class="mb-3 text-lg font-bold text-text-main">2. Accès et hébergement</h2>

        <h3 class="mb-2 font-semibold text-text-main">Authentification</h3>
        <p class="mb-4 text-text-muted">L'accès au Service se fait exclusivement via le portail d'authentification unique (OIDC) de l'École des Mines. Canari ne traite ni ne stocke aucun mot de passe. L'accès est réservé aux membres de la communauté EMSE.</p>

        <h3 class="mb-2 font-semibold text-text-main">Hébergement</h3>
        <p class="mb-4 text-text-muted">Les données sont hébergées sur des serveurs privés gérés par l'association Rootz, situés physiquement à la Maison des Élèves, 158 Cours Fauriel, 42100 Saint-Étienne. Aucune donnée n'est transmise à des clouds publics.</p>

        <h3 class="mb-2 font-semibold text-text-main">Disponibilité</h3>
        <p class="text-text-muted">Le Service est fourni "en l'état". Des interruptions pour maintenance ou incident réseau peuvent survenir sans préavis. L'association Rootz ne garantit pas une disponibilité continue du Service.</p>
      </section>

      <!-- 3 -->
      <section id="chiffrement">
        <h2 class="mb-3 text-lg font-bold text-text-main">3. Chiffrement et sécurité</h2>
        <div class="rounded-xl border border-cn-yellow/30 bg-cn-yellow/5 p-4">
          <p class="font-semibold text-cn-yellow mb-2">Chiffrement de bout en bout</p>
          <p class="text-text-muted">Tous les messages privés sont chiffrés via le protocole MLS (RFC 9420). Le serveur Canari stocke uniquement des blobs chiffrés et n'a techniquement pas accès au contenu de vos conversations. Les clés de chiffrement ne quittent jamais votre appareil.</p>
        </div>
        <ul class="mt-3 space-y-2">
          {#each [
            ['Confidentialité persistante', 'Le protocole MLS garantit que la compromission d\'une clé ne compromet pas les messages passés.'],
            ['Synchronisation multi-appareils', 'Votre état de chiffrement peut être synchronisé entre plusieurs appareils via un mécanisme d\'échange de clés sécurisé (ECDH).'],
            ['Médias', 'Les fichiers et images partagés en privé sont chiffrés côté client avant upload. Le serveur stocke uniquement les données chiffrées.'],
          ] as [titre, desc], i (i)}
            <li class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
              <span class="font-semibold text-cn-yellow">{titre} — </span><span class="text-text-muted">{desc}</span>
            </li>
          {/each}
        </ul>
      </section>

      <!-- 4 -->
      <section id="utilisation">
        <h2 class="mb-3 text-lg font-bold text-text-main">4. Règles d'utilisation</h2>
        <p class="mb-3">En utilisant Canari, vous vous engagez à :</p>
        <ul class="space-y-1 ml-4 list-disc text-text-muted">
          <li>Utiliser le Service uniquement à des fins légales et respectueuses de la communauté EMSE</li>
          <li>Ne pas usurper l'identité d'un autre utilisateur</li>
          <li>Ne pas tenter de compromettre la sécurité du Service ou de ses utilisateurs</li>
          <li>Ne pas diffuser de contenu illicite, haineux, ou portant atteinte à la vie privée d'autrui</li>
          <li>Ne pas utiliser le Service à des fins commerciales non autorisées</li>
          <li>Ne pas tenter de déchiffrer les communications d'autres utilisateurs</li>
          <li>Signaler toute faille de sécurité découverte à <a href="mailto:bureau@rootz-emse.fr" class="text-cn-yellow hover:underline">bureau@rootz-emse.fr</a> plutôt que de l'exploiter</li>
        </ul>

        <p class="mt-4 text-text-muted">Le non-respect de ces règles peut entraîner la suspension ou la suppression de votre compte.</p>
      </section>

      <!-- 5 -->
      <section id="contenu">
        <h2 class="mb-3 text-lg font-bold text-text-main">5. Contenu et publications</h2>

        <h3 class="mb-2 font-semibold text-text-main">Publications publiques</h3>
        <p class="mb-4 text-text-muted">Les posts, commentaires et réactions publiés sur le fil d'actualité sont visibles par tous les membres de la plateforme. Vous restez responsable de l'intégralité du contenu que vous publiez.</p>

        <h3 class="mb-2 font-semibold text-text-main">Associations et workspaces</h3>
        <p class="mb-4 text-text-muted">Les responsables d'association peuvent créer des workspaces et des canaux de discussion. Les canaux utilisent un chiffrement dérivé côté serveur (HKDF) distinct du chiffrement MLS des DMs.</p>

        <h3 class="mb-2 font-semibold text-text-main">Modération</h3>
        <p class="text-text-muted">L'association Rootz se réserve le droit de supprimer tout contenu contraire aux présentes CGU ou aux règles de l'École des Mines, sans obligation de préavis.</p>
      </section>

      <!-- 6 -->
      <section id="donnees">
        <h2 class="mb-3 text-lg font-bold text-text-main">6. Données personnelles</h2>
        <p class="text-text-muted">
          Le traitement de vos données personnelles est détaillé dans notre
          <a href="/legal/privacy" class="text-cn-yellow hover:underline font-medium">Politique de confidentialité</a>.
          Conformément au RGPD, vous disposez d'un droit d'accès, de rectification et de suppression de vos données.
        </p>
      </section>

      <!-- 7 -->
      <section id="propriete">
        <h2 class="mb-3 text-lg font-bold text-text-main">7. Propriété intellectuelle</h2>
        <p class="mb-3 text-text-muted">L'application Canari, son code source et son design sont la propriété de l'association Rootz. Le code est développé en open source sous licence MIT.</p>
        <p class="text-text-muted">Les contenus que vous publiez (textes, images) restent votre propriété. En les publiant, vous accordez à l'association Rootz une licence non exclusive, gratuite et révocable pour les afficher au sein du Service.</p>
      </section>

      <!-- 8 -->
      <section id="responsabilite">
        <h2 class="mb-3 text-lg font-bold text-text-main">8. Responsabilité</h2>
        <p class="mb-3 text-text-muted">L'association Rootz met en œuvre tous les moyens techniques raisonnables pour assurer la sécurité et la disponibilité du Service. Cependant, elle ne peut être tenue responsable :</p>
        <ul class="ml-4 list-disc space-y-1 text-text-muted">
          <li>Des interruptions de service indépendantes de sa volonté</li>
          <li>Du contenu publié par les utilisateurs</li>
          <li>Des dommages résultant d'une utilisation inappropriée du Service</li>
          <li>De la perte de données consécutive à une réinitialisation volontaire de l'appareil</li>
        </ul>
      </section>

      <!-- 9 -->
      <section id="contact">
        <h2 class="mb-3 text-lg font-bold text-text-main">9. Contact et mentions légales</h2>
        <div class="rounded-xl border border-white/20 bg-white/10 p-4 dark:bg-white/5">
          <p><strong>Éditeur</strong></p>
          <p class="text-text-muted">Association Rootz — EMSE</p>
          <p class="text-text-muted">Maison des Élèves, 158 Cours Fauriel, 42100 Saint-Étienne</p>
          <p class="mt-2">
            <strong>Contact RGPD et signalement :</strong>
            <a href="mailto:bureau@rootz-emse.fr" class="text-cn-yellow hover:underline ml-1">bureau@rootz-emse.fr</a>
          </p>
        </div>
      </section>

    </div>

    <!-- Footer -->
    <div class="mt-10 border-t border-white/20 pt-6 text-center text-xs text-text-muted">
      <p>Canari — Mines Saint-Étienne · Association Rootz</p>
      <a href="/legal/privacy" class="mt-1 inline-block text-cn-yellow hover:underline">
        Voir la Politique de confidentialité →
      </a>
    </div>

  </div>
</div>
