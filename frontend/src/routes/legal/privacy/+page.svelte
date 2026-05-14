<script lang="ts">
  import { goto } from '$app/navigation';
</script>

<svelte:head>
  <title>Politique de confidentialité — Canari</title>
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
      <h1 class="text-3xl font-bold text-text-main">Politique de confidentialité</h1>
      <p class="mt-2 text-sm text-text-muted">Canari — Mines Saint-Étienne</p>
      <p class="mt-1 text-xs text-text-muted">Dernière mise à jour : 14/05/2026</p>
    </div>

    <!-- Navigation rapide -->
    <nav class="mb-8 rounded-2xl border border-white/30 bg-white/10 p-4 dark:border-white/10 dark:bg-white/5">
      <p class="mb-2 text-xs font-semibold uppercase tracking-widest text-text-muted">Sommaire</p>
      <ul class="space-y-1 text-sm text-cn-yellow">
        {#each [
          ['#qui', '1. Qui sommes-nous'],
          ['#collecte', '2. Données collectées'],
          ['#permissions', '3. Permissions Android'],
          ['#utilisation', '4. Utilisation des données'],
          ['#stockage', '5. Stockage et sécurité'],
          ['#droits', '6. Vos droits'],
          ['#contact', '7. Contact'],
        ] as [href, label], i (i)}
          <li><a {href} class="hover:underline">{label}</a></li>
        {/each}
      </ul>
    </nav>

    <div class="space-y-8 text-sm leading-relaxed text-text-main">

      <!-- 1 -->
      <section id="qui">
        <h2 class="mb-3 text-lg font-bold text-text-main">1. Qui sommes-nous</h2>
        <p>Canari est une application de messagerie sécurisée développée pour les étudiants de l'École des Mines de Saint-Étienne (EMSE) par l'association <strong>Rootz</strong>.</p>
        <div class="mt-3 rounded-xl border border-white/20 bg-white/10 p-4 dark:bg-white/5">
          <p><strong>Éditeur :</strong> Association Rootz — EMSE</p>
          <p><strong>Hébergement :</strong> Serveurs privés gérés par l'association, hébergés à la Maison des Élèves, 158 Cours Fauriel, 42100 Saint-Étienne</p>
          <p><strong>Contact :</strong> <a href="mailto:rootz@emse.fr" class="text-cn-yellow hover:underline">rootz@emse.fr</a></p>
        </div>
      </section>

      <!-- 2 -->
      <section id="collecte">
        <h2 class="mb-3 text-lg font-bold text-text-main">2. Données collectées</h2>
        <p class="mb-3">Canari collecte uniquement les données nécessaires au bon fonctionnement du service :</p>
        <ul class="space-y-2">
          {#each [
            ['Identité', 'Prénom, nom, e-mail et photo de profil issus de votre compte Mines (via OIDC/Authentik). Aucun mot de passe n\'est transmis à Canari.'],
            ['Messages', 'Vos messages sont chiffrés de bout en bout via le protocole MLS (RFC 9420). Le serveur ne stocke que des blobs chiffrés et ne peut pas lire le contenu.'],
            ['Publications et commentaires', 'Posts, réactions et commentaires que vous créez volontairement sur la plateforme.'],
            ['Tokens de notification', 'Jeton FCM de votre appareil pour l\'envoi de notifications push. Il est stocké côté serveur et supprimé à la déconnexion.'],
            ['Logs techniques', 'Adresse IP et horodatage des requêtes, conservés temporairement à des fins de sécurité.'],
          ] as [titre, desc], i (i)}
            <li class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
              <span class="font-semibold text-cn-yellow">{titre} — </span>{desc}
            </li>
          {/each}
        </ul>
      </section>

      <!-- 3 -->
      <section id="permissions">
        <h2 class="mb-3 text-lg font-bold text-text-main">3. Permissions Android</h2>
        <p class="mb-3">L'application demande les permissions suivantes sur Android :</p>
        <ul class="space-y-2">
          {#each [
            ['CAMERA', 'Accès à l\'appareil photo pour les appels vidéo et le scan de QR codes (synchronisation entre appareils). La caméra n\'est jamais activée sans action explicite de votre part.'],
            ['RECORD_AUDIO', 'Accès au microphone pour les appels audio et vidéo.'],
            ['INTERNET', 'Communication avec les serveurs Canari.'],
            ['POST_NOTIFICATIONS', 'Affichage des notifications de nouveaux messages.'],
            ['READ / WRITE_EXTERNAL_STORAGE', 'Lecture et écriture de fichiers partagés (envoi de pièces jointes et médias).'],
          ] as [permission, desc], i (i)}
            <li class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
              <code class="font-mono text-xs font-semibold text-cn-yellow">{permission}</code>
              <p class="mt-1 text-text-muted">{desc}</p>
            </li>
          {/each}
        </ul>
      </section>

      <!-- 4 -->
      <section id="utilisation">
        <h2 class="mb-3 text-lg font-bold text-text-main">4. Utilisation des données</h2>
        <p class="mb-2">Vos données sont utilisées exclusivement pour :</p>
        <ul class="ml-4 list-disc space-y-1 text-text-muted">
          <li>Vous authentifier et maintenir votre session</li>
          <li>Acheminer vos messages chiffrés vers leurs destinataires</li>
          <li>Afficher votre profil aux membres de la plateforme</li>
          <li>Vous envoyer des notifications push liées à votre activité</li>
          <li>Assurer la sécurité et la stabilité du service</li>
        </ul>
        <p class="mt-3 font-medium">Canari ne vend pas, ne loue pas et ne partage pas vos données avec des tiers à des fins commerciales.</p>
      </section>

      <!-- 5 -->
      <section id="stockage">
        <h2 class="mb-3 text-lg font-bold text-text-main">5. Stockage et sécurité</h2>
        <ul class="space-y-2">
          {#each [
            ['Chiffrement de bout en bout', 'Tous les messages privés sont chiffrés via MLS. Le serveur ne dispose d\'aucune clé permettant de les déchiffrer.'],
            ['Token d\'accès', 'Votre token d\'authentification est conservé en mémoire uniquement (jamais dans le localStorage) et expire après 15 minutes.'],
            ['Données locales', 'L\'état MLS est stocké localement sur votre appareil dans une base de données chiffrée.'],
            ['Hébergement', 'Toutes les données résident sur des serveurs situés à Saint-Étienne, sous le contrôle exclusif de l\'association Rootz. Aucun cloud public n\'est utilisé.'],
          ] as [titre, desc], i (i)}
            <li class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
              <span class="font-semibold text-cn-yellow">{titre} — </span>{desc}
            </li>
          {/each}
        </ul>
      </section>

      <!-- 6 -->
      <section id="droits">
        <h2 class="mb-3 text-lg font-bold text-text-main">6. Vos droits (RGPD)</h2>
        <p class="mb-3">Conformément au Règlement Général sur la Protection des Données (RGPD), vous disposez des droits suivants :</p>
        <ul class="space-y-2">
          {#each [
            ['Accès', 'Consulter l\'ensemble des données vous concernant.'],
            ['Rectification', 'Corriger des informations inexactes via votre profil.'],
            ['Suppression', 'Demander la suppression de votre compte et de vos données associées.'],
            ['Portabilité', 'Recevoir vos données dans un format structuré et lisible.'],
            ['Opposition', 'Vous opposer à certains traitements de données.'],
          ] as [droit, desc], i (i)}
            <li class="flex gap-2 rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
              <span class="mt-0.5 text-green-ok">✓</span>
              <span><strong>{droit}</strong> — {desc}</span>
            </li>
          {/each}
        </ul>
        <p class="mt-3 text-text-muted">Pour exercer ces droits, contactez-nous à <a href="mailto:rootz@emse.fr" class="text-cn-yellow hover:underline">rootz@emse.fr</a>.</p>
      </section>

      <!-- 7 -->
      <section id="contact">
        <h2 class="mb-3 text-lg font-bold text-text-main">7. Contact</h2>
        <div class="rounded-xl border border-white/20 bg-white/10 p-4 dark:bg-white/5">
          <p><strong>Association Rootz</strong></p>
          <p class="text-text-muted">Maison des Élèves, 158 Cours Fauriel, 42100 Saint-Étienne</p>
          <p class="mt-2">
            <a href="mailto:rootz@emse.fr" class="text-cn-yellow hover:underline">rootz@emse.fr</a>
          </p>
        </div>
        <p class="mt-4 text-xs text-text-muted">
          Vous disposez également du droit d'introduire une réclamation auprès de la
          <strong>CNIL</strong> — Commission Nationale de l'Informatique et des Libertés
          (<a href="https://www.cnil.fr" target="_blank" rel="noopener" class="text-cn-yellow hover:underline">www.cnil.fr</a>).
        </p>
      </section>

    </div>

    <!-- Footer -->
    <div class="mt-10 border-t border-white/20 pt-6 text-center text-xs text-text-muted">
      <p>Canari — Mines Saint-Étienne · Association Rootz</p>
      <a href="/legal/cgu" class="mt-1 inline-block text-cn-yellow hover:underline">
        Voir les Conditions Générales d'Utilisation →
      </a>
    </div>

  </div>
</div>
