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

<LegalDocument
  title={m.legal_cgu_title()}
  subtitle={m.legal_cgu_subtitle()}
  updated="29/10/2026"
  {sections}
>
  <!-- 1 -->
  <section id="definitions">
    <h2>1. Définitions</h2>
    <p>Pour la bonne compréhension des présentes conditions :</p>
    <dl class="legal-terms">
      {#each [['Le Service', "L'application Canari (mobile Android et iOS, bureau Windows/macOS/Linux, web) et ses serveurs."], ["L'Éditeur", "L'association étudiante Rootz, affiliée à l'École des Mines de Saint-Étienne."], ["L'Utilisateur", "Toute personne disposant d'un compte MiConnect valide lié à l'École des Mines de Saint-Étienne (EMSE)."], ['MLS', 'Messaging Layer Security (RFC 9420) - protocole de chiffrement de bout en bout utilisé pour les messages privés.'], ['Association', 'Groupe ou organisation étudiante créé au sein de la plateforme.'], ['Contenu', 'Tout texte, image, fichier ou média publié ou envoyé via le Service par un Utilisateur.'], ['Direct', "Vidéo diffusée en temps réel par un Utilisateur via le Service, avec son chat et ses réactions (« live » dans l'application)."]] as [terme, def], i (i)}
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
        >L'utilisation du Service est interdite aux personnes de moins de 15 ans.</strong
      > L'accès s'effectue exclusivement via MiConnect, le service de connexion des associations (relié
      au CAS de l'École) ; Canari ne traite ni ne stocke aucun mot de passe.
    </p>
    <p>
      En accédant au Service, vous déclarez avoir l'âge minimum requis et être autorisé à accepter
      les présentes CGU. Cet âge minimum est fixé par référence à l'article 45 de la loi
      Informatique et Libertés ; un mineur de 15 ans ou plus peut utiliser le Service.
    </p>
  </section>

  <!-- 3 -->
  <section id="hebergement">
    <h2>3. Accès et hébergement</h2>

    <h3>Hébergement</h3>
    <p>
      Le Service fonctionne sur un serveur partagé de l'École des Mines de Saint-Étienne, en France,
      administré avec la direction des systèmes d'information (DSI) de l'École ; ses sauvegardes
      sont copiées sur une seconde machine de l'École. Les anciens noms de domaine passent encore
      par Cloudflare. Les destinataires et sous-traitants sont listés dans la
      <a href="/legal/privacy#tiers">Politique de confidentialité §4</a>.
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
        conversations. Les clés de chiffrement ne sont jamais transmises au serveur en clair.
      </p>
    </div>
    <dl class="legal-terms">
      {#each [['Confidentialité persistante', "Le protocole MLS garantit que la compromission d'une clé ne compromet pas les messages passés."], ['Synchronisation multi-appareils', 'Chacun de vos appareils rejoint vos conversations chiffrées ; une sauvegarde chiffrée par votre code PIN permet de restaurer votre historique.'], ['Médias', 'Les fichiers et images partagés en privé sont chiffrés côté client avant upload. Le serveur stocke uniquement les données chiffrées.']] as [titre, desc], i (i)}
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
      Les responsables d'association peuvent créer des communautés et des salons de discussion. Les
      messages de salon sont chiffrés de bout en bout par un mécanisme distinct du chiffrement MLS
      des conversations privées ; le serveur ne détient pas les clés permettant de les lire.
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

    <h3 id="directs">Directs (quand la fonction est ouverte)</h3>
    <p>
      Tout Utilisateur peut lancer un direct en son nom ; le lancer au nom d'une association demande
      le droit de publier en son nom. Un direct est visible des mêmes membres qu'une publication du
      même auteur : ceux qui partagent un espace avec vous ou, au nom d'une association, ceux
      qu'elle atteint. Vos abonnés (ou ceux de l'association) qui peuvent le voir reçoivent une
      notification quand il commence. L'Éditeur peut fermer la fonction à tout moment, pour tout le
      Service.
    </p>
    <dl class="legal-terms">
      <div>
        <dt>Règles</dt>
        <dd>
          Les règles de la section 5 s'appliquent à l'image, au son et au chat d'un direct comme à
          une publication, et celles de la section 7 sans exception. Vous acceptez les règles de la
          section 5 avant votre premier direct. En direct, il est en outre interdit de filmer une
          personne qui n'a pas accepté d'y apparaître.
        </dd>
      </div>
      <div>
        <dt>Responsabilité</dt>
        <dd>
          Vous êtes seul responsable de ce que vous diffusez, y compris au nom d'une association.
          Chaque auteur d'un message du chat est responsable de son message.
        </dd>
      </div>
      <div>
        <dt>Pas d'enregistrement</dt>
        <dd>
          Canari n'enregistre pas les directs et n'en propose aucune rediffusion : la vidéo et le
          chat sont supprimés à la fin du direct, dans les conditions de la
          <a href="/legal/privacy#retention">{m.legal_privacy_link()} §6</a>. Rien n'empêche
          toutefois un spectateur de filmer son écran.
        </dd>
      </div>
      <div>
        <dt>Limites</dt>
        <dd>
          Un direct s'arrête après 60 secondes sans image reçue. Vous ne pouvez avoir qu'un direct
          ouvert à la fois, et en lancer six par heure au plus. Le nombre de spectateurs simultanés
          est limité : au-delà, l'accès est refusé.
        </dd>
      </div>
      <div>
        <dt>Vos outils</dt>
        <dd>
          Vous pouvez retirer un spectateur de votre direct et masquer un message du chat. Vous et
          les spectateurs voyez combien de personnes regardent, jamais qui. Un blocage, dans un sens
          ou dans l'autre, empêche de voir le direct de l'autre.
        </dd>
      </div>
      <div>
        <dt>Signalement</dt>
        <dd>
          Tout spectateur peut signaler un direct, ou un message de son chat, depuis le direct.
          Signaler un message transmet son texte à la modération, qui le conserve jusqu'au
          traitement du signalement. La modération s'efforce d'examiner un signalement de direct
          dans les 24 heures, samedi et dimanche non comptés.
        </dd>
      </div>
      <div>
        <dt>Coupure</dt>
        <dd>
          Un modérateur peut couper un direct en cours, ou sanctionner un direct qui vient de se
          terminer ; un direct coupé prend fin pour tous. Vous êtes prévenu avec le motif (spam,
          harcèlement, contenu inapproprié, autre), sauf pour une première coupure d'un direct déjà
          terminé. Un direct n'est jamais coupé automatiquement, quel que soit le nombre de
          signalements.
        </dd>
      </div>
      <div>
        <dt>Sanctions</dt>
        <dd>
          Une coupure reste inscrite 90 jours. La première vaut avertissement. La deuxième dans ce
          délai, et chacune des suivantes, <strong
            >suspend votre droit de lancer un direct pendant 30 jours à compter de la coupure</strong
          >. À partir de la troisième, la modération peut aussi vous
          <strong>retirer ce droit</strong>
          jusqu'à ce qu'elle vous le rende. Une coupure d'un direct diffusé au nom d'une association compte
          pour vous. Ces mesures ne concernent que les directs ; les mesures de la section 5 restent possibles,
          et un compte restreint (muté) ne peut ni lancer un direct, ni écrire ni réagir dans un chat.
        </dd>
      </div>
    </dl>

    <h3>Recours</h3>
    <p>
      Toute décision de modération (suppression de contenu, restriction de compte, coupure d'un
      direct, suspension ou retrait du droit de lancer un direct) peut faire l'objet d'un recours
      par e-mail à
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
      des transactions financières traitées par <strong>Lydia</strong>
      (prestataire de paiement français, présenté dans l'application sous le nom « Paiement Canari »).
      En effectuant un paiement, vous acceptez également les conditions d'utilisation de ce prestataire,
      affichées sur sa page de paiement. Canari ne stocke jamais vos coordonnées bancaires.
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
        <strong>Paramètres > Supprimer mon compte</strong>. La suppression est immédiate et
        irréversible : profil, publications, adhésions, appareils et jetons de notification sont
        effacés, ainsi que vos messages de salon ; vos achats sont conservés détachés de votre
        compte. Le détail figure dans la
        <a href="/legal/privacy#droits">{m.legal_privacy_link()} §10</a>.
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
        Délai de traitement : 30 jours au plus.
      </p>
    </div>

    <p>
      Certaines données peuvent être conservées au-delà si la loi l'exige (ex. données comptables
      liées à des transactions). Ces exceptions sont détaillées dans la
      <a href="/legal/privacy#retention">{m.legal_privacy_link()} §6</a>, avec la durée pendant
      laquelle une donnée supprimée subsiste dans les sauvegardes.
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
      d'opposition, exercés selon la procédure de sa section 10. Pour toute demande :
      <a href="mailto:bureau@rootz-emse.fr">bureau@rootz-emse.fr</a>.
    </p>
  </section>

  <!-- 11 -->
  <section id="propriete">
    <h2>11. Propriété intellectuelle</h2>
    <p>
      L'application Canari, son code source et son design sont la propriété de l'association Rootz.
      Son code source est public, publié sous la licence PolyForm Noncommercial 1.0.0.
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
        Des actes ou omissions des sous-traitants (notamment Google, Apple, Cloudflare, Lydia,
        KLIPY) dans les limites de la loi applicable
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
