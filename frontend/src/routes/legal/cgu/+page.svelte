<script lang="ts">
  import { goto } from '$app/navigation';
</script>

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
        Retour
      </button>
      <div
        class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#151B2C] shadow-lg"
      >
        <img src="/favicon.png" alt="Canari" class="h-8 w-8 object-contain" />
      </div>
      <h1 class="text-3xl font-bold text-text-main">Conditions Générales d'Utilisation</h1>
      <p class="mt-2 text-sm text-text-muted">Canari - Messagerie sécurisée EMSE</p>
      <p class="mt-1 text-xs text-text-muted">Dernière mise à jour : 28/05/2026</p>
    </div>

    <!-- Navigation rapide -->
    <nav
      class="mb-8 rounded-2xl border border-white/30 bg-white/10 p-4 dark:border-white/10 dark:bg-white/5"
    >
      <p class="mb-2 text-xs font-semibold uppercase tracking-widest text-text-muted">Sommaire</p>
      <ul class="space-y-1 text-sm text-cn-yellow">
        {#each [['#definitions', '1. Définitions'], ['#age', '2. Âge minimum et accès'], ['#hebergement', '3. Accès et hébergement'], ['#chiffrement', '4. Chiffrement et sécurité'], ['#regles', "5. Règles d'utilisation"], ['#contenu', '6. Contenu, modération et signalement'], ['#enfants', '7. Sécurité des enfants'], ['#paiements', '8. Paiements et remboursements'], ['#suppression', '9. Suppression de compte'], ['#donnees', '10. Données personnelles'], ['#propriete', '11. Propriété intellectuelle'], ['#responsabilite', '12. Responsabilité'], ['#droit', '13. Droit applicable et litiges'], ['#modifications', '14. Modifications des CGU'], ['#contact', '15. Contact']] as [href, label], i (i)}
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
          {#each [['Le Service', "L'application Canari (mobile Android, bureau Windows/macOS/Linux, web) et son infrastructure backend."], ["L'Éditeur", "L'association étudiante Rootz, affiliée à l'École des Mines de Saint-Étienne."], ["L'Utilisateur", "Toute personne disposant d'un compte valide lié à l'École des Mines de Saint-Étienne (EMSE)."], ['MLS', 'Messaging Layer Security (RFC 9420) - protocole de chiffrement de bout en bout utilisé pour les messages privés.'], ['Association', 'Groupe ou organisation étudiante créé au sein de la plateforme.'], ['Contenu', 'Tout texte, image, fichier ou média publié ou envoyé via le Service par un Utilisateur.']] as [terme, def], i (i)}
            <li class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
              <span class="font-semibold text-cn-yellow">{terme} - </span><span
                class="text-text-muted">{def}</span
              >
            </li>
          {/each}
        </ul>
      </section>

      <!-- 2 -->
      <section id="age">
        <h2 class="mb-3 text-lg font-bold text-text-main">2. Âge minimum et accès</h2>
        <p class="mb-3 text-text-muted">
          L'accès au Service est réservé aux membres de la communauté EMSE titulaires d'un compte
          institutionnel valide. <strong
            >L'utilisation du Service est interdite aux personnes de moins de 13 ans.</strong
          > L'accès s'effectue exclusivement via le portail d'authentification unique (OIDC) de l'École
          des Mines ; Canari ne traite ni ne stocke aucun mot de passe.
        </p>
        <p class="text-text-muted">
          En accédant au Service, vous déclarez avoir l'âge minimum requis et être autorisé à
          accepter les présentes CGU. Si vous êtes mineur, vous devez obtenir l'accord de votre
          parent ou tuteur légal.
        </p>
      </section>

      <!-- 3 -->
      <section id="hebergement">
        <h2 class="mb-3 text-lg font-bold text-text-main">3. Accès et hébergement</h2>

        <h3 class="mb-2 font-semibold text-text-main">Hébergement</h3>
        <p class="mb-4 text-text-muted">
          Les données sont hébergées sur des serveurs privés gérés par l'association Rootz, situés
          physiquement à la Maison des Élèves de l'École des Mines, 20 Boulevard Alexandre de
          Fraissinette, 42100 Saint-Étienne. Aucune donnée principale n'est transmise à des clouds
          publics (voir la
          <a href="/legal/privacy#tiers" class="text-cn-yellow hover:underline"
            >Politique de confidentialité §3</a
          >
          pour les sous-traitants).
        </p>

        <h3 class="mb-2 font-semibold text-text-main">Disponibilité</h3>
        <p class="text-text-muted">
          Le Service est fourni "en l'état". Des interruptions pour maintenance ou incident réseau
          peuvent survenir sans préavis. L'association Rootz ne garantit pas une disponibilité
          continue du Service.
        </p>
      </section>

      <!-- 4 -->
      <section id="chiffrement">
        <h2 class="mb-3 text-lg font-bold text-text-main">4. Chiffrement et sécurité</h2>
        <div class="rounded-xl border border-cn-yellow/30 bg-cn-yellow/5 p-4">
          <p class="font-semibold text-cn-yellow mb-2">Chiffrement de bout en bout</p>
          <p class="text-text-muted">
            Tous les messages privés sont chiffrés via le protocole MLS (RFC 9420). Le serveur
            Canari stocke uniquement des blobs chiffrés et n'a techniquement pas accès au contenu de
            vos conversations. Les clés de chiffrement ne quittent jamais votre appareil.
          </p>
        </div>
        <ul class="mt-3 space-y-2">
          {#each [['Confidentialité persistante', "Le protocole MLS garantit que la compromission d'une clé ne compromet pas les messages passés."], ['Synchronisation multi-appareils', "Votre état de chiffrement peut être synchronisé entre plusieurs appareils via un mécanisme d'échange de clés sécurisé (ECDH)."], ['Médias', 'Les fichiers et images partagés en privé sont chiffrés côté client avant upload. Le serveur stocke uniquement les données chiffrées.']] as [titre, desc], i (i)}
            <li class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
              <span class="font-semibold text-cn-yellow">{titre} - </span><span
                class="text-text-muted">{desc}</span
              >
            </li>
          {/each}
        </ul>
      </section>

      <!-- 5 -->
      <section id="regles">
        <h2 class="mb-3 text-lg font-bold text-text-main">5. Règles d'utilisation</h2>
        <p class="mb-3">En utilisant Canari, vous vous engagez à :</p>
        <ul class="space-y-1 ml-4 list-disc text-text-muted">
          <li>
            Utiliser le Service uniquement à des fins légales et respectueuses de la communauté EMSE
          </li>
          <li>Ne pas usurper l'identité d'un autre utilisateur</li>
          <li>Ne pas tenter de compromettre la sécurité du Service ou de ses utilisateurs</li>
          <li>
            Ne pas diffuser de contenu illicite, haineux, discriminatoire, ou portant atteinte à la
            vie privée d'autrui
          </li>
          <li>Ne pas partager de contenu à caractère sexuel explicite ou pornographique</li>
          <li>Ne pas harceler, menacer ou intimider d'autres utilisateurs</li>
          <li>Ne pas utiliser le Service à des fins commerciales non autorisées par l'Éditeur</li>
          <li>Ne pas tenter de déchiffrer les communications d'autres utilisateurs</li>
          <li>Ne pas diffuser de logiciels malveillants ou de liens frauduleux</li>
          <li>
            Signaler toute faille de sécurité découverte à <a
              href="mailto:bureau@rootz-emse.fr"
              class="text-cn-yellow hover:underline">bureau@rootz-emse.fr</a
            > plutôt que de l'exploiter
          </li>
        </ul>
        <p class="mt-4 text-text-muted">
          Le non-respect de ces règles peut entraîner la suspension immédiate ou la suppression
          définitive de votre compte, sans obligation de préavis.
        </p>
      </section>

      <!-- 6 -->
      <section id="contenu">
        <h2 class="mb-3 text-lg font-bold text-text-main">6. Contenu, modération et signalement</h2>

        <h3 class="mb-2 font-semibold text-text-main">Publications publiques</h3>
        <p class="mb-4 text-text-muted">
          Les posts, commentaires et réactions publiés sur le fil d'actualité sont visibles par tous
          les membres de la plateforme. Vous restez seul responsable de l'intégralité du contenu que
          vous publiez.
        </p>

        <h3 class="mb-2 font-semibold text-text-main">Associations et workspaces</h3>
        <p class="mb-4 text-text-muted">
          Les responsables d'association peuvent créer des workspaces et des canaux de discussion.
          Les canaux utilisent un chiffrement dérivé côté serveur (HKDF) distinct du chiffrement MLS
          des messages directs.
        </p>

        <h3 class="mb-2 font-semibold text-text-main">Signalement de contenu</h3>
        <p class="mb-3 text-text-muted">
          Si vous observez un contenu ou un comportement contraire aux présentes CGU, vous pouvez le
          signaler directement depuis l'application via le bouton <em>" Signaler "</em> présent sur chaque
          publication. Vous pouvez également contacter l'équipe de modération par e-mail :
        </p>
        <div class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5 mb-3">
          <p class="text-text-muted">
            <strong>E-mail :</strong>
            <a href="mailto:bureau@rootz-emse.fr" class="text-cn-yellow hover:underline ml-1"
              >bureau@rootz-emse.fr</a
            >
            - Objet recommandé : <em>" Signalement contenu Canari "</em>
          </p>
        </div>
        <p class="text-text-muted text-xs">
          Précisez la nature du contenu signalé, la date approximative, et l'identifiant de
          l'utilisateur concerné si connu.
        </p>

        <h3 class="mb-2 mt-5 font-semibold text-text-main">Politique de modération</h3>
        <p class="mb-3 text-text-muted">
          La modération suit un processus en deux étapes visant à équilibrer la liberté d'expression
          et la sécurité de la communauté :
        </p>
        <ul class="space-y-2 mb-4">
          <li class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
            <span class="font-semibold text-cn-yellow">Masquage automatique - </span>
            <span class="text-text-muted">
              Dès qu'un post accumule <strong>5 signalements distincts</strong> (de 5 utilisateurs différents),
              il est automatiquement masqué des fils d'actualité et placé en file de révision. L'auteur
              ne reçoit pas de notification à ce stade.
            </span>
          </li>
          <li class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
            <span class="font-semibold text-cn-yellow">Révision manuelle - </span>
            <span class="text-text-muted">
              Un modérateur (membre du BDE disposant du droit MODERATE, ou administrateur global)
              examine le contenu masqué et décide de le <strong>restaurer</strong> si le signalement
              est infondé, ou de le <strong>supprimer</strong> s'il viole les CGU. Dans ce dernier cas,
              l'auteur peut également être restreint (muté) : il conserve l'accès en lecture mais ne peut
              plus publier, commenter ou réagir.
            </span>
          </li>
        </ul>
        <p class="text-text-muted text-xs mb-4">
          Les signalements abusifs ou de mauvaise foi peuvent eux-mêmes faire l'objet de mesures de
          modération. Le seuil de masquage automatique peut évoluer en fonction de l'usage réel de
          la plateforme.
        </p>

        <h3 class="mb-2 font-semibold text-text-main">Recours</h3>
        <p class="text-text-muted">
          Toute décision de modération (suppression de contenu, restriction de compte) peut faire
          l'objet d'un recours par e-mail à
          <a href="mailto:bureau@rootz-emse.fr" class="text-cn-yellow hover:underline"
            >bureau@rootz-emse.fr</a
          >
          en précisant l'objet du litige. L'association Rootz s'engage à examiner les recours dans un
          délai raisonnable et à motiver sa réponse.
        </p>
      </section>

      <!-- 7 -->
      <section id="enfants">
        <h2 class="mb-3 text-lg font-bold text-text-main">7. Sécurité des enfants</h2>
        <div class="rounded-xl border border-red-500/30 bg-red-500/5 p-4 mb-3">
          <p class="font-semibold text-red-400 mb-2">Interdiction absolue des CSAE</p>
          <p class="text-text-muted">
            L'application <strong>Canari</strong>, éditée par l'association <strong>Rootz</strong>,
            interdit strictement toute forme d'abus et d'exploitation sexuels d'enfants (CSAE),
            notamment la production, le partage ou la possession de matériel d'abus sexuel sur
            mineurs (CSAM), la sollicitation sexuelle de mineurs, ou tout contenu à caractère sexuel
            impliquant des personnes mineures.
          </p>
        </div>
        <p class="text-text-muted">
          Tout contenu ou comportement relevant des CSAE entraîne la suspension immédiate du compte
          et un signalement aux autorités judiciaires compétentes. Pour en savoir plus ou signaler
          un abus, consultez nos
          <a href="/legal/child-safety" class="text-cn-yellow hover:underline font-medium"
            >Normes de sécurité des enfants</a
          >.
        </p>
      </section>

      <!-- 8 -->
      <section id="paiements">
        <h2 class="mb-3 text-lg font-bold text-text-main">8. Paiements et remboursements</h2>

        <h3 class="mb-2 font-semibold text-text-main">Traitement des paiements</h3>
        <p class="mb-4 text-text-muted">
          Certaines fonctionnalités de Canari (billetterie événements, formulaires payants)
          impliquent des transactions financières traitées par <strong>Stripe, Inc.</strong>
          (prestataire de paiement certifié PCI DSS niveau 1). En effectuant un paiement, vous
          acceptez également les
          <a
            href="https://stripe.com/fr/legal/end-users"
            target="_blank"
            rel="noopener"
            class="text-cn-yellow hover:underline">conditions d'utilisation de Stripe</a
          >. Canari ne stocke jamais vos coordonnées bancaires.
        </p>

        <h3 class="mb-2 font-semibold text-text-main">Politique de remboursement</h3>
        <p class="mb-3 text-text-muted">
          Les conditions de remboursement varient selon le type de transaction :
        </p>
        <ul class="space-y-2">
          <li class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
            <span class="font-semibold text-cn-yellow">Événements et billets - </span>
            <span class="text-text-muted"
              >Le remboursement est à la discrétion de l'association organisatrice, dont les
              conditions sont indiquées sur la page de l'événement.</span
            >
          </li>
          <li class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
            <span class="font-semibold text-cn-yellow">Formulaires payants - </span>
            <span class="text-text-muted"
              >Remboursement possible sur demande à <a
                href="mailto:bureau@rootz-emse.fr"
                class="text-cn-yellow hover:underline">bureau@rootz-emse.fr</a
              > dans les 14 jours suivant le paiement, sous réserve que la prestation n'ait pas débuté.</span
            >
          </li>
          <li class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5">
            <span class="font-semibold text-cn-yellow">Dons et contributions - </span>
            <span class="text-text-muted"
              >Les dons sont en principe non remboursables, sauf erreur manifeste ou transaction non
              autorisée.</span
            >
          </li>
        </ul>

        <p class="mt-3 text-text-muted">
          En cas de litige relatif à une transaction, contactez-nous à
          <a href="mailto:bureau@rootz-emse.fr" class="text-cn-yellow hover:underline"
            >bureau@rootz-emse.fr</a
          >
          en précisant la date, le montant et la nature de la transaction.
        </p>
      </section>

      <!-- 9 -->
      <section id="suppression">
        <h2 class="mb-3 text-lg font-bold text-text-main">9. Suppression de compte</h2>

        <h3 class="mb-2 font-semibold text-text-main">Suppression depuis l'application</h3>
        <div class="rounded-xl border border-cn-yellow/30 bg-cn-yellow/5 p-4 mb-3">
          <p class="font-semibold text-cn-yellow mb-2">
            Méthode principale - directement dans Canari
          </p>
          <p class="text-text-muted">
            Vous pouvez supprimer votre compte à tout moment depuis
            <strong>Profil → Supprimer mon compte</strong>. La suppression est immédiate et
            irréversible : profil, messages privés, publications, réactions et jetons de
            notification sont effacés définitivement.
          </p>
        </div>

        <h3 class="mb-2 font-semibold text-text-main">
          Suppression par e-mail (accès à l'app impossible)
        </h3>
        <p class="mb-2 text-text-muted">
          Si vous ne pouvez plus accéder à l'application (ex. après désinstallation), envoyez votre
          demande à :
        </p>
        <div class="rounded-xl border border-white/20 bg-white/10 p-3 dark:bg-white/5 mb-3">
          <p class="font-medium">
            <a href="mailto:bureau@rootz-emse.fr" class="text-cn-yellow hover:underline"
              >bureau@rootz-emse.fr</a
            >
          </p>
          <p class="mt-1 text-text-muted text-xs">
            Objet : <em>" Suppression compte Canari "</em> - depuis l'adresse e-mail liée à votre compte
            EMSE. Délai de traitement : 30 jours maximum.
          </p>
        </div>

        <p class="text-text-muted">
          Certaines données peuvent être conservées au-delà si la loi l'exige (ex. données
          comptables liées à des transactions). Ces exceptions sont détaillées dans la
          <a href="/legal/privacy#retention" class="text-cn-yellow hover:underline"
            >Politique de confidentialité §5</a
          >.
        </p>

        <p class="mt-3 text-text-muted">
          <strong>La désinstallation seule ne supprime pas votre compte.</strong>
          Une action explicite (in-app ou par e-mail) est nécessaire.
        </p>
      </section>

      <!-- 10 -->
      <section id="donnees">
        <h2 class="mb-3 text-lg font-bold text-text-main">10. Données personnelles</h2>
        <p class="text-text-muted">
          Le traitement de vos données personnelles est détaillé dans notre
          <a href="/legal/privacy" class="text-cn-yellow hover:underline font-medium"
            >Politique de confidentialité</a
          >. Conformément au RGPD, vous disposez d'un droit d'accès, de rectification, de
          suppression, de limitation, de portabilité et d'opposition. Pour toute demande :
          <a href="mailto:bureau@rootz-emse.fr" class="text-cn-yellow hover:underline"
            >bureau@rootz-emse.fr</a
          >.
        </p>
      </section>

      <!-- 11 -->
      <section id="propriete">
        <h2 class="mb-3 text-lg font-bold text-text-main">11. Propriété intellectuelle</h2>
        <p class="mb-3 text-text-muted">
          L'application Canari, son code source et son design sont la propriété de l'association
          Rootz. Le code est développé en open source sous licence MIT.
        </p>
        <p class="text-text-muted">
          Les contenus que vous publiez (textes, images) restent votre propriété. En les publiant,
          vous accordez à l'association Rootz une licence non exclusive, gratuite et révocable pour
          les afficher au sein du Service.
        </p>
      </section>

      <!-- 12 -->
      <section id="responsabilite">
        <h2 class="mb-3 text-lg font-bold text-text-main">12. Responsabilité</h2>
        <p class="mb-3 text-text-muted">
          L'association Rootz met en œuvre tous les moyens techniques raisonnables pour assurer la
          sécurité et la disponibilité du Service. Cependant, elle ne peut être tenue responsable :
        </p>
        <ul class="ml-4 list-disc space-y-1 text-text-muted">
          <li>Des interruptions de service indépendantes de sa volonté</li>
          <li>Du contenu publié par les utilisateurs</li>
          <li>Des dommages résultant d'une utilisation inappropriée du Service</li>
          <li>
            De la perte de données consécutive à une réinitialisation volontaire de l'appareil
          </li>
          <li>
            Des actes ou omissions des sous-traitants (Firebase, Stripe) dans les limites de la loi
            applicable
          </li>
        </ul>
      </section>

      <!-- 13 -->
      <section id="droit">
        <h2 class="mb-3 text-lg font-bold text-text-main">13. Droit applicable et litiges</h2>
        <p class="mb-3 text-text-muted">
          Les présentes CGU sont soumises au <strong>droit français</strong>. En cas de litige
          relatif à l'interprétation ou à l'exécution des présentes, les parties s'engagent à
          rechercher une solution amiable avant tout recours judiciaire.
        </p>
        <p class="text-text-muted">
          À défaut d'accord amiable, tout litige sera soumis à la compétence exclusive des tribunaux
          compétents du ressort de Saint-Étienne, sauf disposition légale contraire applicable à
          votre situation (notamment pour les consommateurs résidant dans l'UE).
        </p>
      </section>

      <!-- 14 -->
      <section id="modifications">
        <h2 class="mb-3 text-lg font-bold text-text-main">14. Modifications des CGU</h2>
        <p class="text-text-muted">
          L'association Rootz se réserve le droit de modifier les présentes CGU à tout moment. En
          cas de modification substantielle, vous serez notifié par une notification dans
          l'application au moins <strong>15 jours avant</strong> l'entrée en vigueur des changements.
          La date de " Dernière mise à jour " en haut de cette page reflète la version en vigueur. La
          poursuite de l'utilisation du Service après cette date vaut acceptation des nouvelles conditions.
          Si vous refusez les nouvelles conditions, vous devez cesser d'utiliser le Service et demander
          la suppression de votre compte (section 9).
        </p>
      </section>

      <!-- 15 -->
      <section id="contact">
        <h2 class="mb-3 text-lg font-bold text-text-main">15. Contact et mentions légales</h2>
        <div class="rounded-xl border border-white/20 bg-white/10 p-4 dark:bg-white/5">
          <p><strong>Éditeur</strong></p>
          <p class="text-text-muted">Association Rootz - EMSE</p>
          <p class="text-text-muted">
            Maison des Élèves de l'École des Mines, 20 Boulevard Alexandre de Fraissinette, 42100
            Saint-Étienne
          </p>
          <p class="mt-2">
            <strong>Contact RGPD, signalement et support :</strong>
            <a href="mailto:bureau@rootz-emse.fr" class="text-cn-yellow hover:underline ml-1"
              >bureau@rootz-emse.fr</a
            >
          </p>
        </div>
      </section>
    </div>

    <!-- Footer -->
    <div class="mt-10 border-t border-white/20 pt-6 text-center text-xs text-text-muted">
      <p>Canari - Mines Saint-Étienne · Association Rootz</p>
      <div class="mt-2 flex justify-center gap-4">
        <a href="/legal/privacy" class="text-cn-yellow hover:underline"
          >Politique de confidentialité</a
        >
        <a href="/legal/child-safety" class="text-cn-yellow hover:underline">Sécurité des enfants</a
        >
      </div>
    </div>
  </div>
</div>
