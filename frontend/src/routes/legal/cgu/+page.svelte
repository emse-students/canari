<script lang="ts">
  import LegalDocument from '$lib/components/legal/LegalDocument.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * The document's own sections, in order. Numbered here because the DOCUMENT numbers
   * them - the rail renders the label verbatim and never counts.
   */
  const sections = [
    { id: 'definitions', label: '1. Définitions' },
    { id: 'age', label: '2. Âge minimum et accès' },
    { id: 'hebergement', label: '3. Accès et hébergement' },
    { id: 'chiffrement', label: '4. Chiffrement et sécurité' },
    { id: 'regles', label: "5. Règles d'utilisation" },
    { id: 'contenu', label: '6. Contenu, modération et signalement' },
    { id: 'enfants', label: '7. Sécurité des enfants' },
    { id: 'paiements', label: '8. Paiements et remboursements' },
    { id: 'suppression', label: '9. Suppression de compte' },
    { id: 'donnees', label: '10. Données personnelles' },
    { id: 'propriete', label: '11. Propriété intellectuelle' },
    { id: 'responsabilite', label: '12. Responsabilité' },
    { id: 'droit', label: '13. Droit applicable et litiges' },
    { id: 'modifications', label: '14. Modifications des CGU' },
    { id: 'contact', label: '15. Contact' },
  ];
</script>

<svelte:head>
  <title>{m.legal_cgu_title()} - Canari</title>
</svelte:head>

<LegalDocument
  title={m.legal_cgu_title()}
  subtitle={m.legal_cgu_subtitle()}
  updated="28/05/2026"
  {sections}
>
  <!-- 1 -->
  <section id="definitions">
    <h2>1. Définitions</h2>
    <p>Pour la bonne compréhension des présentes conditions :</p>
    <dl class="legal-terms">
      {#each [['Le Service', "L'application Canari (mobile Android, bureau Windows/macOS/Linux, web) et son infrastructure backend."], ["L'Éditeur", "L'association étudiante Rootz, affiliée à l'École des Mines de Saint-Étienne."], ["L'Utilisateur", "Toute personne disposant d'un compte valide lié à l'École des Mines de Saint-Étienne (EMSE)."], ['MLS', 'Messaging Layer Security (RFC 9420) - protocole de chiffrement de bout en bout utilisé pour les messages privés.'], ['Association', 'Groupe ou organisation étudiante créé au sein de la plateforme.'], ['Contenu', 'Tout texte, image, fichier ou média publié ou envoyé via le Service par un Utilisateur.']] as [terme, def], i (i)}
        <div>
          <dt>{terme}</dt>
          <dd>{def}</dd>
        </div>
      {/each}
    </dl>
  </section>

  <!-- 2 -->
  <section id="age">
    <h2>2. Âge minimum et accès</h2>
    <p>
      L'accès au Service est réservé aux membres de la communauté EMSE titulaires d'un compte
      institutionnel valide. <strong
        >L'utilisation du Service est interdite aux personnes de moins de 13 ans.</strong
      > L'accès s'effectue exclusivement via le portail d'authentification unique (OIDC) de l'École des
      Mines ; Canari ne traite ni ne stocke aucun mot de passe.
    </p>
    <p>
      En accédant au Service, vous déclarez avoir l'âge minimum requis et être autorisé à accepter
      les présentes CGU. Si vous êtes mineur, vous devez obtenir l'accord de votre parent ou tuteur
      légal.
    </p>
  </section>

  <!-- 3 -->
  <section id="hebergement">
    <h2>3. Accès et hébergement</h2>

    <h3>Hébergement</h3>
    <p>
      Les données sont hébergées sur des serveurs privés gérés par l'association Rootz, situés
      physiquement à la Maison des Élèves de l'École des Mines, 20 Boulevard Alexandre de
      Fraissinette, 42100 Saint-Étienne. Aucune donnée principale n'est transmise à des clouds
      publics (voir la
      <a href="/legal/privacy#tiers">Politique de confidentialité §3</a>
      pour les sous-traitants).
    </p>

    <h3>Disponibilité</h3>
    <p>
      Le Service est fourni "en l'état". Des interruptions pour maintenance ou incident réseau
      peuvent survenir sans préavis. L'association Rootz ne garantit pas une disponibilité continue
      du Service.
    </p>
  </section>

  <!-- 4 -->
  <section id="chiffrement">
    <h2>4. Chiffrement et sécurité</h2>
    <div class="legal-note">
      <p class="legal-callout-title">Chiffrement de bout en bout</p>
      <p>
        Tous les messages privés sont chiffrés via le protocole MLS (RFC 9420). Le serveur Canari
        stocke uniquement des blobs chiffrés et n'a techniquement pas accès au contenu de vos
        conversations. Les clés de chiffrement ne quittent jamais votre appareil.
      </p>
    </div>
    <dl class="legal-terms">
      {#each [['Confidentialité persistante', "Le protocole MLS garantit que la compromission d'une clé ne compromet pas les messages passés."], ['Synchronisation multi-appareils', "Votre état de chiffrement peut être synchronisé entre plusieurs appareils via un mécanisme d'échange de clés sécurisé (ECDH)."], ['Médias', 'Les fichiers et images partagés en privé sont chiffrés côté client avant upload. Le serveur stocke uniquement les données chiffrées.']] as [titre, desc], i (i)}
        <div>
          <dt>{titre}</dt>
          <dd>{desc}</dd>
        </div>
      {/each}
    </dl>
  </section>

  <!-- 5 -->
  <section id="regles">
    <h2>5. Règles d'utilisation</h2>
    <p>En utilisant Canari, vous vous engagez à :</p>
    <ul>
      <li>
        Utiliser le Service uniquement à des fins légales et respectueuses de la communauté EMSE
      </li>
      <li>Ne pas usurper l'identité d'un autre utilisateur</li>
      <li>Ne pas tenter de compromettre la sécurité du Service ou de ses utilisateurs</li>
      <li>
        Ne pas diffuser de contenu illicite, haineux, discriminatoire, ou portant atteinte à la vie
        privée d'autrui
      </li>
      <li>Ne pas partager de contenu à caractère sexuel explicite ou pornographique</li>
      <li>Ne pas harceler, menacer ou intimider d'autres utilisateurs</li>
      <li>Ne pas utiliser le Service à des fins commerciales non autorisées par l'Éditeur</li>
      <li>Ne pas tenter de déchiffrer les communications d'autres utilisateurs</li>
      <li>Ne pas diffuser de logiciels malveillants ou de liens frauduleux</li>
      <li>
        Signaler toute faille de sécurité découverte à <a href="mailto:bureau@rootz-emse.fr"
          >bureau@rootz-emse.fr</a
        > plutôt que de l'exploiter
      </li>
    </ul>
    <p>
      Le non-respect de ces règles peut entraîner la suspension immédiate ou la suppression
      définitive de votre compte, sans obligation de préavis.
    </p>
  </section>

  <!-- 6 -->
  <section id="contenu">
    <h2>6. Contenu, modération et signalement</h2>

    <h3>Publications publiques</h3>
    <p>
      Les posts, commentaires et réactions publiés sur le fil d'actualité sont visibles par tous les
      membres de la plateforme. Vous restez seul responsable de l'intégralité du contenu que vous
      publiez.
    </p>

    <h3>Associations et workspaces</h3>
    <p>
      Les responsables d'association peuvent créer des workspaces et des canaux de discussion. Les
      canaux utilisent un chiffrement dérivé côté serveur (HKDF) distinct du chiffrement MLS des
      messages directs.
    </p>

    <h3>Signalement de contenu</h3>
    <p>
      Si vous observez un contenu ou un comportement contraire aux présentes CGU, vous pouvez le
      signaler directement depuis l'application via le bouton <em>" Signaler "</em> présent sur chaque
      publication. Vous pouvez également contacter l'équipe de modération par e-mail :
    </p>
    <div class="legal-block">
      <p>
        <strong>E-mail :</strong>
        <a href="mailto:bureau@rootz-emse.fr">bureau@rootz-emse.fr</a>
        - Objet recommandé : <em>" Signalement contenu Canari "</em>
      </p>
    </div>
    <p class="legal-fineprint">
      Précisez la nature du contenu signalé, la date approximative, et l'identifiant de
      l'utilisateur concerné si connu.
    </p>

    <h3>Politique de modération</h3>
    <p>
      La modération suit un processus en deux étapes visant à équilibrer la liberté d'expression et
      la sécurité de la communauté :
    </p>
    <dl class="legal-terms">
      <div>
        <dt>Masquage automatique</dt>
        <dd>
          Dès qu'un post accumule <strong>5 signalements distincts</strong> (de 5 utilisateurs différents),
          il est automatiquement masqué des fils d'actualité et placé en file de révision. L'auteur ne
          reçoit pas de notification à ce stade.
        </dd>
      </div>
      <div>
        <dt>Révision manuelle</dt>
        <dd>
          Un modérateur (membre du BDE disposant du droit MODERATE, ou administrateur global)
          examine le contenu masqué et décide de le <strong>restaurer</strong> si le signalement est
          infondé, ou de le <strong>supprimer</strong> s'il viole les CGU. Dans ce dernier cas, l'auteur
          peut également être restreint (muté) : il conserve l'accès en lecture mais ne peut plus publier,
          commenter ou réagir.
        </dd>
      </div>
    </dl>
    <p class="legal-fineprint">
      Les signalements abusifs ou de mauvaise foi peuvent eux-mêmes faire l'objet de mesures de
      modération. Le seuil de masquage automatique peut évoluer en fonction de l'usage réel de la
      plateforme.
    </p>

    <h3>Recours</h3>
    <p>
      Toute décision de modération (suppression de contenu, restriction de compte) peut faire
      l'objet d'un recours par e-mail à
      <a href="mailto:bureau@rootz-emse.fr">bureau@rootz-emse.fr</a>
      en précisant l'objet du litige. L'association Rootz s'engage à examiner les recours dans un délai
      raisonnable et à motiver sa réponse.
    </p>
  </section>

  <!-- 7 -->
  <section id="enfants">
    <h2>7. Sécurité des enfants</h2>
    <div class="legal-alert">
      <p class="legal-callout-title">Interdiction absolue des CSAE</p>
      <p>
        L'application <strong>Canari</strong>, éditée par l'association <strong>Rootz</strong>,
        interdit strictement toute forme d'abus et d'exploitation sexuels d'enfants (CSAE),
        notamment la production, le partage ou la possession de matériel d'abus sexuel sur mineurs
        (CSAM), la sollicitation sexuelle de mineurs, ou tout contenu à caractère sexuel impliquant
        des personnes mineures.
      </p>
    </div>
    <p>
      Tout contenu ou comportement relevant des CSAE entraîne la suspension immédiate du compte et
      un signalement aux autorités judiciaires compétentes. Pour en savoir plus ou signaler un abus,
      consultez nos
      <a href="/legal/child-safety">{m.legal_child_safety_link()}</a>.
    </p>
  </section>

  <!-- 8 -->
  <section id="paiements">
    <h2>8. Paiements et remboursements</h2>

    <h3>Traitement des paiements</h3>
    <p>
      Certaines fonctionnalités de Canari (billetterie événements, formulaires payants) impliquent
      des transactions financières traitées par <strong>Stripe, Inc.</strong>
      (prestataire de paiement certifié PCI DSS niveau 1). En effectuant un paiement, vous acceptez également
      les
      <a href="https://stripe.com/fr/legal/end-users" target="_blank" rel="noopener"
        >conditions d'utilisation de Stripe</a
      >. Canari ne stocke jamais vos coordonnées bancaires.
    </p>

    <h3>Politique de remboursement</h3>
    <p>Les conditions de remboursement varient selon le type de transaction :</p>
    <dl class="legal-terms">
      <div>
        <dt>Événements et billets</dt>
        <dd>
          Le remboursement est à la discrétion de l'association organisatrice, dont les conditions
          sont indiquées sur la page de l'événement.
        </dd>
      </div>
      <div>
        <dt>Formulaires payants</dt>
        <dd>
          Remboursement possible sur demande à <a href="mailto:bureau@rootz-emse.fr"
            >bureau@rootz-emse.fr</a
          > dans les 14 jours suivant le paiement, sous réserve que la prestation n'ait pas débuté.
        </dd>
      </div>
      <div>
        <dt>Dons et contributions</dt>
        <dd>
          Les dons sont en principe non remboursables, sauf erreur manifeste ou transaction non
          autorisée.
        </dd>
      </div>
    </dl>

    <p>
      En cas de litige relatif à une transaction, contactez-nous à
      <a href="mailto:bureau@rootz-emse.fr">bureau@rootz-emse.fr</a>
      en précisant la date, le montant et la nature de la transaction.
    </p>
  </section>

  <!-- 9 -->
  <section id="suppression">
    <h2>9. Suppression de compte</h2>

    <h3>Suppression depuis l'application</h3>
    <div class="legal-note">
      <p class="legal-callout-title">Méthode principale - directement dans Canari</p>
      <p>
        Vous pouvez supprimer votre compte à tout moment depuis
        <strong>Profil → Supprimer mon compte</strong>. La suppression est immédiate et irréversible
        : profil, messages privés, publications, réactions et jetons de notification sont effacés
        définitivement.
      </p>
    </div>

    <h3>Suppression par e-mail (accès à l'app impossible)</h3>
    <p>
      Si vous ne pouvez plus accéder à l'application (ex. après désinstallation), envoyez votre
      demande à :
    </p>
    <div class="legal-block">
      <p>
        <a href="mailto:bureau@rootz-emse.fr">bureau@rootz-emse.fr</a>
      </p>
      <p class="legal-fineprint">
        Objet : <em>" Suppression compte Canari "</em> - depuis l'adresse e-mail liée à votre compte EMSE.
        Délai de traitement : 30 jours maximum.
      </p>
    </div>

    <p>
      Certaines données peuvent être conservées au-delà si la loi l'exige (ex. données comptables
      liées à des transactions). Ces exceptions sont détaillées dans la
      <a href="/legal/privacy#retention">{m.legal_privacy_link()} §5</a>.
    </p>

    <p>
      <strong>La désinstallation seule ne supprime pas votre compte.</strong>
      Une action explicite (in-app ou par e-mail) est nécessaire.
    </p>
  </section>

  <!-- 10 -->
  <section id="donnees">
    <h2>10. Données personnelles</h2>
    <p>
      Le traitement de vos données personnelles est détaillé dans notre
      <a href="/legal/privacy">{m.legal_privacy_link()}</a>. Conformément au RGPD, vous disposez
      d'un droit d'accès, de rectification, de suppression, de limitation, de portabilité et
      d'opposition. Pour toute demande :
      <a href="mailto:bureau@rootz-emse.fr">bureau@rootz-emse.fr</a>.
    </p>
  </section>

  <!-- 11 -->
  <section id="propriete">
    <h2>11. Propriété intellectuelle</h2>
    <p>
      L'application Canari, son code source et son design sont la propriété de l'association Rootz.
      Le code est développé en open source sous licence MIT.
    </p>
    <p>
      Les contenus que vous publiez (textes, images) restent votre propriété. En les publiant, vous
      accordez à l'association Rootz une licence non exclusive, gratuite et révocable pour les
      afficher au sein du Service.
    </p>
  </section>

  <!-- 12 -->
  <section id="responsabilite">
    <h2>12. Responsabilité</h2>
    <p>
      L'association Rootz met en œuvre tous les moyens techniques raisonnables pour assurer la
      sécurité et la disponibilité du Service. Cependant, elle ne peut être tenue responsable :
    </p>
    <ul>
      <li>Des interruptions de service indépendantes de sa volonté</li>
      <li>Du contenu publié par les utilisateurs</li>
      <li>Des dommages résultant d'une utilisation inappropriée du Service</li>
      <li>De la perte de données consécutive à une réinitialisation volontaire de l'appareil</li>
      <li>
        Des actes ou omissions des sous-traitants (Firebase, Stripe) dans les limites de la loi
        applicable
      </li>
    </ul>
  </section>

  <!-- 13 -->
  <section id="droit">
    <h2>13. Droit applicable et litiges</h2>
    <p>
      Les présentes CGU sont soumises au <strong>droit français</strong>. En cas de litige relatif à
      l'interprétation ou à l'exécution des présentes, les parties s'engagent à rechercher une
      solution amiable avant tout recours judiciaire.
    </p>
    <p>
      À défaut d'accord amiable, tout litige sera soumis à la compétence exclusive des tribunaux
      compétents du ressort de Saint-Étienne, sauf disposition légale contraire applicable à votre
      situation (notamment pour les consommateurs résidant dans l'UE).
    </p>
  </section>

  <!-- 14 -->
  <section id="modifications">
    <h2>14. Modifications des CGU</h2>
    <p>
      L'association Rootz se réserve le droit de modifier les présentes CGU à tout moment. En cas de
      modification substantielle, vous serez notifié par une notification dans l'application au
      moins <strong>15 jours avant</strong> l'entrée en vigueur des changements. La date de " Dernière
      mise à jour " en haut de cette page reflète la version en vigueur. La poursuite de l'utilisation
      du Service après cette date vaut acceptation des nouvelles conditions. Si vous refusez les nouvelles
      conditions, vous devez cesser d'utiliser le Service et demander la suppression de votre compte (section
      9).
    </p>
  </section>

  <!-- 15 -->
  <section id="contact">
    <h2>15. Contact et mentions légales</h2>
    <div class="legal-block">
      <p><strong>Éditeur</strong></p>
      <p>Association Rootz - EMSE</p>
      <p>
        Maison des Élèves de l'École des Mines, 20 Boulevard Alexandre de Fraissinette, 42100
        Saint-Étienne
      </p>
      <p>
        <strong>Contact RGPD, signalement et support :</strong>
        <a href="mailto:bureau@rootz-emse.fr">bureau@rootz-emse.fr</a>
      </p>
    </div>
  </section>
</LegalDocument>
