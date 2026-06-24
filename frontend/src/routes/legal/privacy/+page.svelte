<script lang="ts">
  import { goto } from '$app/navigation';
  import { m } from '$lib/paraglide/messages';
</script>

<svelte:head>
  <title>{m.legal_privacy_title()} - Canari</title>
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
        onclick={() => goto(-1 as never)}
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
      <h1 class="text-3xl font-bold text-text-main">{m.legal_privacy_title()}</h1>
      <p class="mt-2 text-sm text-text-muted">{m.legal_privacy_subtitle()}</p>
      <p class="mt-1 text-xs text-text-muted">Dernière mise à jour : 21/05/2026</p>
    </div>

    <!-- Navigation rapide -->
    <nav
      class="mb-8 rounded-2xl border border-white/30 bg-white/10 p-4 dark:border-white/10 dark:bg-white/5"
    >
      <p class="mb-2 text-xs font-semibold uppercase tracking-widest text-text-muted">{m.legal_toc_heading()}</p>
      <ul class="space-y-1 text-sm text-cn-yellow">
        {#each [['#qui', '1. Qui sommes-nous'], ['#collecte', '2. Données collectées'], ['#tiers', '3. Sous-traitants et tiers'], ['#utilisation', '4. Utilisation des données'], ['#retention', '5. Durée de conservation'], ['#stockage', '6. Stockage et sécurité'], ['#transferts', '7. Transferts internationaux'], ['#age', '8. Âge minimum'], ['#droits', '9. Vos droits (RGPD)'], ['#modifications', '10. Modifications'], ['#contact', '11. Contact']] as [href, label], i (i)}
          <li><a {href} class="hover:underline">{label}</a></li>
        {/each}
      </ul>
    </nav>

    <div class="space-y-8 text-sm leading-relaxed text-text-main">
      <!-- 1 -->
      <section id="qui">
        <h2 class="mb-3 text-lg font-bold text-text-main">1. Qui sommes-nous</h2>
        <p class="mb-3">
          <strong>Canari</strong> est une application de messagerie sécurisée développée pour les
          étudiants de l'École des Mines de Saint-Étienne (EMSE) par l'association
          <strong>Rootz</strong>.
        </p>
        <div class="rounded-xl border border-white/20 bg-white/10 p-4 dark:bg-white/5 space-y-1">
          <p><strong>Responsable du traitement :</strong> Association Rootz - EMSE</p>
          <p class="text-text-muted">
            Maison des Élèves de l'École des Mines, 20 Boulevard Alexandre de Fraissinette, 42100
            Saint-Étienne, France
          </p>
          <p>
            <strong>Contact :</strong>
            <a href="mailto:bureau@rootz-emse.fr" class="text-cn-yellow hover:underline"
              >bureau@rootz-emse.fr</a
            >
          </p>
        </div>
        <p class="mt-3 text-text-muted">
          La présente politique s'applique à l'application Canari sur toutes les plateformes
          (Android, iOS, bureau Windows/macOS/Linux, web) et à l'infrastructure backend associée.
        </p>
      </section>

      <!-- 2 -->
      <section id="collecte">
        <h2 class="mb-3 text-lg font-bold text-text-main">2. Données collectées</h2>
        <p class="mb-3">
          Canari collecte uniquement les données nécessaires au fonctionnement du service :
        </p>
        <ul class="space-y-2">
          {#each [['Identité', "Prénom, nom, adresse e-mail et photo de profil transmis par le portail d'authentification OIDC de l'École des Mines (Authentik). Canari ne traite ni ne stocke jamais votre mot de passe."], ['Messages privés', "Vos messages sont chiffrés de bout en bout via le protocole MLS (RFC 9420) avant d'être envoyés. Le serveur ne stocke que des blobs chiffrés et est techniquement incapable de lire le contenu de vos conversations."], ['Publications et commentaires', 'Posts, réactions et commentaires créés volontairement sur la plateforme. Ces contenus sont visibles par les membres de la communauté EMSE.'], ['Jeton de notification push', "Jeton FCM (Firebase Cloud Messaging) de votre appareil, utilisé pour l'envoi de notifications. Stocké côté serveur et supprimé à la déconnexion ou à la suppression du compte."], ['Données de paiement', 'Pour les paiements (formulaires, événements), Canari fait appel à Stripe. Canari ne stocke aucune donnée bancaire - numéro de carte, IBAN ou CVV. Ces données sont traitées directement par Stripe (voir section 3).'], ['Logs techniques', 'Adresse IP et horodatage des requêtes HTTP, conservés temporairement à des fins de sécurité et de débogage.']] as [titre, desc], i (i)}
            <li class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
              <span class="font-semibold text-cn-yellow">{titre} - </span>{desc}
            </li>
          {/each}
        </ul>
        <p class="mt-3 text-text-muted">
          Canari ne collecte pas de données de localisation, d'historique de navigation, de liste
          d'applications installées, ni aucune autre donnée non listée ici.
        </p>
      </section>

      <!-- 3 -->
      <section id="tiers">
        <h2 class="mb-3 text-lg font-bold text-text-main">3. Sous-traitants et tiers</h2>
        <p class="mb-3 text-text-muted">
          Canari fait appel à des sous-traitants pour deux fonctionnalités spécifiques. Ces
          prestataires ne reçoivent que les données strictement nécessaires à leur mission.
        </p>
        <ul class="space-y-3">
          <li class="rounded-xl border border-white/20 bg-white/10 p-4 dark:bg-white/5">
            <p class="font-semibold text-cn-yellow">Google Firebase (FCM) - Notifications push</p>
            <p class="mt-1 text-text-muted">
              Firebase Cloud Messaging (Google LLC, Mountain View, CA, USA) est utilisé pour l'envoi
              de notifications push sur mobile. Le jeton FCM de votre appareil est transmis aux
              serveurs Google pour acheminer les notifications. Ce transfert est couvert par les
              clauses contractuelles types UE-US (section 7). Politique de confidentialité Google :
              <a
                href="https://policies.google.com/privacy"
                target="_blank"
                rel="noopener"
                class="text-cn-yellow hover:underline">policies.google.com/privacy</a
              >.
            </p>
          </li>
          <li class="rounded-xl border border-white/20 bg-white/10 p-4 dark:bg-white/5">
            <p class="font-semibold text-cn-yellow">Stripe - Traitement des paiements</p>
            <p class="mt-1 text-text-muted">
              Stripe, Inc. (South San Francisco, CA, USA) traite les paiements effectués via les
              formulaires et événements payants. Lorsque vous effectuez un paiement, vos données
              financières sont transmises directement à Stripe ; Canari ne reçoit et ne stocke
              jamais vos coordonnées bancaires. Stripe est certifié PCI DSS niveau 1. Politique de
              confidentialité Stripe :
              <a
                href="https://stripe.com/fr/privacy"
                target="_blank"
                rel="noopener"
                class="text-cn-yellow hover:underline">stripe.com/fr/privacy</a
              >.
            </p>
          </li>
        </ul>
        <p class="mt-3 text-text-muted">
          Canari ne vend, ne loue et ne partage pas vos données personnelles avec d'autres tiers à
          des fins commerciales ou publicitaires. Aucun SDK de tracking, d'analytics tiers ou de
          publicité n'est intégré à l'application.
        </p>
      </section>

      <!-- 4 -->
      <section id="utilisation">
        <h2 class="mb-3 text-lg font-bold text-text-main">4. Utilisation des données</h2>
        <p class="mb-2">Vos données sont utilisées exclusivement pour :</p>
        <ul class="ml-4 list-disc space-y-1 text-text-muted">
          <li>Vous authentifier et maintenir votre session active</li>
          <li>Acheminer vos messages chiffrés vers leurs destinataires</li>
          <li>Afficher votre profil aux autres membres de la plateforme</li>
          <li>Vous envoyer des notifications push liées à votre activité sur Canari</li>
          <li>Traiter les paiements que vous initiez (via Stripe)</li>
          <li>Assurer la sécurité, la stabilité et le débogage du service</li>
        </ul>
        <p class="mt-3 text-text-muted">
          Les données collectées pour une finalité ne sont pas réutilisées pour une autre finalité
          sans votre consentement explicite.
        </p>
      </section>

      <!-- 5 -->
      <section id="retention">
        <h2 class="mb-3 text-lg font-bold text-text-main">5. Durée de conservation</h2>
        <ul class="space-y-2">
          {#each [['Données de profil', "Conservées pendant toute la durée d'activité de votre compte. Supprimées dans les 30 jours suivant une demande de suppression de compte."], ['Messages privés (blobs chiffrés)', "Conservés jusqu'à suppression par l'utilisateur ou suppression du compte. Les messages supprimés sont effacés définitivement des serveurs."], ['Publications et commentaires', "Conservés jusqu'à suppression manuelle ou suppression du compte."], ['Jeton FCM', 'Supprimé immédiatement à la déconnexion ou à la révocation du compte.'], ['Logs techniques (IP, horodatage)', 'Conservés au maximum 90 jours à des fins de sécurité, puis supprimés automatiquement.'], ['Données de paiement (Stripe)', 'Conservées par Stripe selon leur propre politique (généralement 7 ans pour la conformité fiscale). Canari conserve uniquement un identifiant de transaction Stripe à des fins comptables.']] as [titre, desc], i (i)}
            <li class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
              <span class="font-semibold text-cn-yellow">{titre} - </span><span
                class="text-text-muted">{desc}</span
              >
            </li>
          {/each}
        </ul>
      </section>

      <!-- 6 -->
      <section id="stockage">
        <h2 class="mb-3 text-lg font-bold text-text-main">6. Stockage et sécurité</h2>
        <ul class="space-y-2">
          {#each [['Chiffrement de bout en bout', "Tous les messages privés sont chiffrés via MLS (RFC 9420). Le serveur ne dispose d'aucune clé permettant de les déchiffrer."], ["Token d'accès", 'Votre token JWT est conservé en mémoire uniquement (jamais dans le localStorage ou les cookies persistants) et expire après 15 minutes.'], ['Données locales', "L'état MLS est stocké localement sur votre appareil dans une base de données chiffrée."], ['Hébergement principal', "Toutes les données résident sur des serveurs situés à Saint-Étienne, sous le contrôle exclusif de l'association Rootz. Aucun cloud public européen ou américain n'est utilisé pour le stockage principal."], ['Transmission', 'Toutes les communications entre votre appareil et nos serveurs sont chiffrées via TLS 1.2 minimum.']] as [titre, desc], i (i)}
            <li class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
              <span class="font-semibold text-cn-yellow">{titre} - </span><span
                class="text-text-muted">{desc}</span
              >
            </li>
          {/each}
        </ul>
      </section>

      <!-- 7 -->
      <section id="transferts">
        <h2 class="mb-3 text-lg font-bold text-text-main">7. Transferts internationaux</h2>
        <p class="mb-3 text-text-muted">
          Les données hébergées sur les serveurs de l'association Rootz restent en France
          (Saint-Étienne). Cependant, deux transferts vers des pays tiers peuvent avoir lieu dans le
          cadre des sous-traitants décrits à la section 3 :
        </p>
        <ul class="space-y-2">
          <li class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
            <span class="font-semibold text-cn-yellow">Google Firebase (FCM) - États-Unis</span>
            <p class="mt-1 text-text-muted">
              Le jeton FCM est transmis aux serveurs de Google LLC aux États-Unis. Ce transfert est
              encadré par les clauses contractuelles types (CCT) adoptées par la Commission
              européenne conformément à l'article 46 du RGPD.
            </p>
          </li>
          <li class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
            <span class="font-semibold text-cn-yellow">Stripe - États-Unis</span>
            <p class="mt-1 text-text-muted">
              Les données de paiement sont traitées par Stripe Inc. aux États-Unis. Ce transfert est
              également encadré par les CCT. Stripe est en outre certifié PCI DSS et adhère au cadre
              EU-US Data Privacy Framework.
            </p>
          </li>
        </ul>
      </section>

      <!-- 8 -->
      <section id="age">
        <h2 class="mb-3 text-lg font-bold text-text-main">8. Âge minimum</h2>
        <p class="text-text-muted">
          Canari est réservé aux membres de la communauté de l'École des Mines de Saint-Étienne.
          L'accès est conditionné à la possession d'un compte institutionnel EMSE valide.
          <strong>L'application n'est pas destinée aux enfants de moins de 13 ans</strong> (ou l'âge
          minimum requis par la loi applicable dans votre pays, si plus élevé). Nous ne collectons
          pas sciemment de données personnelles auprès de mineurs de moins de 13 ans. Si vous êtes
          parent ou tuteur et pensez que votre enfant nous a fourni des données, contactez-nous à
          <a href="mailto:bureau@rootz-emse.fr" class="text-cn-yellow hover:underline"
            >bureau@rootz-emse.fr</a
          >
          pour demander leur suppression immédiate.
        </p>
      </section>

      <!-- 9 -->
      <section id="droits">
        <h2 class="mb-3 text-lg font-bold text-text-main">9. Vos droits (RGPD)</h2>
        <p class="mb-3">
          Conformément au RGPD (Règlement UE 2016/679), vous disposez des droits suivants :
        </p>
        <ul class="space-y-2">
          {#each [['Accès', "Obtenir une copie de l'ensemble des données vous concernant traitées par Canari."], ['Rectification', "Corriger des informations inexactes. Le nom, prénom et e-mail provenant de l'EMSE doivent être corrigés via votre compte institutionnel."], ['Suppression', 'Demander la suppression de votre compte et de toutes les données associées. Voir ci-dessous.'], ['Limitation', 'Demander la suspension temporaire du traitement de vos données.'], ['Portabilité', 'Recevoir vos données dans un format structuré, lisible par machine (JSON).'], ['Opposition', 'Vous opposer à certains traitements, dans la mesure compatible avec la nature du service.']] as [droit, desc], i (i)}
            <li
              class="flex gap-2 rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5"
            >
              <span class="mt-0.5 text-green-ok">✓</span>
              <span><strong>{droit}</strong> - {desc}</span>
            </li>
          {/each}
        </ul>

        <div class="mt-4 rounded-xl border border-cn-yellow/30 bg-cn-yellow/5 p-4">
          <p class="font-semibold text-cn-yellow mb-2">Suppression de compte et de données</p>
          <p class="text-text-muted mb-2">
            Pour demander la suppression de votre compte et de toutes les données associées, envoyez
            un e-mail à <a href="mailto:bureau@rootz-emse.fr" class="text-cn-yellow hover:underline"
              >bureau@rootz-emse.fr</a
            >
            avec l'objet <em>" Suppression compte Canari "</em> depuis l'adresse e-mail liée à votre compte
            EMSE. Nous traiterons votre demande dans un délai de 30 jours.
          </p>
          <p class="text-text-muted text-xs">
            Certaines données peuvent être conservées au-delà de ce délai si la loi l'exige (ex.
            données de transaction à des fins fiscales/comptables, logs de sécurité en cas
            d'incident en cours).
          </p>
        </div>

        <div class="mt-4 rounded-xl border border-white/20 bg-white/10 p-4 dark:bg-white/5">
          <p class="font-semibold mb-2">Notification de violation de données</p>
          <p class="text-text-muted">
            En cas de violation de données susceptible d'engendrer un risque pour vos droits et
            libertés, l'association Rootz notifiera la CNIL dans les 72 heures conformément à
            l'article 33 du RGPD. Si cette violation est susceptible d'engendrer un risque élevé,
            vous serez également notifié directement (article 34 du RGPD) dans les meilleurs délais.
          </p>
        </div>

        <p class="mt-3 text-text-muted">
          Pour exercer vos droits, contactez-nous à
          <a href="mailto:bureau@rootz-emse.fr" class="text-cn-yellow hover:underline"
            >bureau@rootz-emse.fr</a
          >. Vous disposez également du droit d'introduire une réclamation auprès de la
          <strong>CNIL</strong> (<a
            href="https://www.cnil.fr"
            target="_blank"
            rel="noopener"
            class="text-cn-yellow hover:underline">www.cnil.fr</a
          >).
        </p>
      </section>

      <!-- 10 -->
      <section id="modifications">
        <h2 class="mb-3 text-lg font-bold text-text-main">10. Modifications de la politique</h2>
        <p class="text-text-muted">
          L'association Rootz se réserve le droit de modifier la présente politique à tout moment,
          notamment pour se conformer à de nouvelles obligations légales ou à l'évolution du
          service. En cas de modification substantielle, vous serez notifié par une notification
          dans l'application au moins 15 jours avant l'entrée en vigueur des changements. La date de
          " Dernière mise à jour " en haut de cette page reflète la version en vigueur. La poursuite
          de l'utilisation de Canari après cette date vaut acceptation des nouvelles conditions.
        </p>
      </section>

      <!-- 11 -->
      <section id="contact">
        <h2 class="mb-3 text-lg font-bold text-text-main">11. Contact</h2>
        <div class="rounded-xl border border-white/20 bg-white/10 p-4 dark:bg-white/5">
          <p><strong>Association Rootz</strong></p>
          <p class="text-text-muted">
            Maison des Élèves de l'École des Mines, 20 Boulevard Alexandre de Fraissinette, 42100
            Saint-Étienne
          </p>
          <p class="mt-2">
            <a href="mailto:bureau@rootz-emse.fr" class="text-cn-yellow hover:underline"
              >bureau@rootz-emse.fr</a
            >
          </p>
        </div>
      </section>
    </div>

    <!-- Footer -->
    <div class="mt-10 border-t border-white/20 pt-6 text-center text-xs text-text-muted">
      <p>{m.legal_footer_credits()}</p>
      <div class="mt-2 flex justify-center gap-4">
        <a href="/legal/cgu" class="text-cn-yellow hover:underline">{m.legal_cgu_link()}</a>
        <a href="/legal/child-safety" class="text-cn-yellow hover:underline">{m.legal_child_safety_link()}</a>
      </div>
    </div>
  </div>
</div>
