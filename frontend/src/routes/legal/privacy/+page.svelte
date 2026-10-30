<script lang="ts">
  import LegalDocument from '$lib/components/legal/LegalDocument.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * The document's own sections, in order. Numbered here because the DOCUMENT numbers
   * them - the rail renders the label verbatim and never counts.
   *
   * Every statement below is backed by the code or by the wiki page named in
   * docs/wiki/compliance/register-of-processing.md, which is the Art. 30 register this text is the
   * public face of. CHANGE ONE, CHANGE THE OTHER, and bump `updated`.
   */
  const sections = [
    { id: 'qui', label: '1. Qui sommes-nous' },
    { id: 'collecte', label: '2. Données traitées' },
    { id: 'finalites', label: '3. Finalités et bases légales' },
    { id: 'tiers', label: '4. Destinataires et sous-traitants' },
    { id: 'transferts', label: "5. Transferts hors de l'UE" },
    { id: 'retention', label: '6. Durées de conservation' },
    { id: 'local', label: '7. Cookies et stockage local' },
    { id: 'stockage', label: '8. Hébergement et sécurité' },
    { id: 'age', label: '9. Âge minimum et mineurs' },
    { id: 'droits', label: '10. Vos droits et comment les exercer' },
    { id: 'violation', label: '11. Violation de données' },
    { id: 'modifications', label: '12. Modifications' },
    { id: 'contact', label: '13. Contact' },
  ];
</script>

<LegalDocument
  title={m.legal_privacy_title()}
  subtitle={m.legal_privacy_subtitle()}
  updated="29/10/2026"
  {sections}
>
  <!-- 1 -->
  <section id="qui">
    <h2>1. Qui sommes-nous</h2>
    <p>
      <strong>Canari</strong> est une application de messagerie et de vie associative développée
      pour les élèves et le personnel de l'École des Mines de Saint-Étienne (EMSE) par l'association
      <strong>Rootz</strong>. Elle n'est pas éditée par l'administration de l'École.
    </p>
    <div class="legal-block">
      <p><strong>Responsable du traitement :</strong> Association Rootz - EMSE</p>
      <p>
        Maison des Élèves de l'École des Mines, 20 Boulevard Alexandre de Fraissinette, 42100
        Saint-Étienne, France
      </p>
      <p>
        <strong>Contact :</strong>
        <a href="mailto:bureau@rootz-emse.fr">bureau@rootz-emse.fr</a>
      </p>
    </div>
    <p>
      La présente politique s'applique à l'application Canari sur toutes les plateformes (Android,
      iOS, bureau Windows/macOS/Linux, web) et à ses serveurs. La connexion passe par
      <strong>MiConnect</strong>, le service de connexion des associations, qui publie ses propres
      conditions ; les autres services de l'écosystème (MiGallery, Sky, Le Cercle) ont chacun les
      leurs.
    </p>
  </section>

  <!-- 2 -->
  <section id="collecte">
    <h2>2. Données traitées</h2>
    <dl class="legal-terms">
      <div>
        <dt>Identité et profil</dt>
        <dd>
          Prénom, nom, identifiant de connexion, promotion, formation, campus, parcours et
          appartenances (élève, personnel, Maison des Élèves), transmis par MiConnect à chaque
          connexion ; la biographie que vous écrivez. Canari ne reçoit pas votre adresse e-mail
          personnelle et ne connaît pas votre mot de passe. Votre photo de profil est servie par
          MiGallery.
        </dd>
      </div>
      <div>
        <dt>Messages privés et de groupe</dt>
        <dd>
          Chiffrés de bout en bout (protocole MLS, RFC 9420) sur votre appareil avant l'envoi. Le
          serveur ne détient que des contenus chiffrés qu'il ne peut pas lire. Il connaît en
          revanche, en clair : les membres de chaque conversation, le nom des groupes, l'expéditeur,
          l'heure et la taille de chaque message.
        </dd>
      </div>
      <div>
        <dt>Communautés et salons</dt>
        <dd>
          Les messages de salon sont chiffrés de bout en bout ; le nom des communautés et des
          salons, leurs membres et les accusés de lecture affichés dans un salon sont connus du
          serveur. Quand un message de salon est supprimé, le serveur garde son auteur et son
          identifiant aléatoire pendant 30 jours, pour ne pas le republier si l'application renvoie
          un envoi interrompu.
        </dd>
      </div>
      <div>
        <dt>Publications, commentaires, réactions, sondages, CanaReels</dt>
        <dd>
          Contenus que vous publiez volontairement sur le fil, visibles par les membres de la
          plateforme selon l'audience choisie. Les fichiers joints sont chiffrés avant l'envoi. Une
          association peut vous demander de relayer une de vos publications personnelles : la
          demande (l'association, le membre qui l'a faite, la publication) vous est adressée, et
          rien n'est montré à son public tant que vous n'avez pas accepté. Vous pouvez retirer ce
          relais à tout moment ; la demande est effacée avec la publication ou avec votre compte.
          Vous pouvez publier ou commenter de façon anonyme, ou au nom d'une association dont vous
          avez le droit de parler : les autres membres ne voient alors pas votre compte, mais la
          modération et les administrateurs de la plateforme peuvent l'identifier (pour traiter un
          signalement, par exemple), et votre compte reste responsable de ce que vous écrivez. Un
          commentaire écrit au nom d'une association lui appartient : il reste si vous supprimez
          votre compte, détaché de celui-ci.
        </dd>
      </div>
      <div>
        <dt>Directs (quand la fonction est ouverte)</dt>
        <dd>
          Quand vous lancez un direct, la vidéo est découpée sur votre appareil en courts segments,
          chiffrés avant l'envoi avec une clé propre au direct. Notre serveur conserve cette clé
          (chiffrée dans la base de données par un secret du serveur) et la remet aux membres
          autorisés à regarder : <strong>ce n'est donc pas un chiffrement de bout en bout</strong>.
          Le stockage des fichiers et le cache de notre serveur web ne détiennent que des segments
          chiffrés ; notre serveur, qui détient la clé, pourrait les déchiffrer, mais il ne
          déchiffre un contenu de direct que pour vérifier un message du chat signalé (voir «
          Signalements, blocages et modération »). Le serveur connaît en clair : qui diffuse et au
          nom de quelle association, les heures de début et de fin du direct et la raison de sa fin,
          la taille de chaque segment, les membres que vous retirez du direct, et, pour chaque
          spectateur, le fait qu'il regarde (son compte et l'heure de sa dernière lecture). Le
          nombre de spectateurs est affiché à vous et à ceux qui regardent ; aucune fonction de
          Canari ne montre leur liste, ni à vous ni à la modération. Les messages du chat sont
          chiffrés avec la même clé ; leur auteur est connu du serveur et son nom est affiché aux
          autres spectateurs. Les réactions (cœur, rire, bravo, feu, poussin) ne sont pas chiffrées
          : le serveur enregistre qui réagit et compte les réactions. Un direct n'est pas enregistré
          et n'a pas de rediffusion. Avant votre premier direct, vous acceptez les règles de
          publication : la version acceptée et sa date sont conservées. Pour limiter les abus, le
          serveur garde aussi l'heure de chacun de vos démarrages pendant une heure. Les journaux
          techniques notent les débuts et fins de direct, les coupures et les retraits de
          spectateurs, avec le début de l'identifiant du compte concerné, et, comme pour toute
          requête, le serveur web journalise l'adresse IP de chaque lecture.
        </dd>
      </div>
      <div>
        <dt>Abonnements et demandes d'abonnement</dt>
        <dd>
          Pour suivre une personne, vous lui envoyez une demande : elle reçoit une notification à
          votre nom, puis l'accepte ou la refuse ; un refus n'est signalé à personne. Si elle
          accepte, vous en êtes notifié. Sont conservées la demande et sa date, puis, si elle est
          acceptée, la date d'acceptation ; un refus supprime la demande. Vous pouvez consulter la
          liste de vos abonnés et en retirer quelqu'un. Pour ne jamais notifier deux fois la même
          personne et limiter le nombre de nouvelles demandes par jour, le serveur garde aussi le
          fait qu'une demande (ou son acceptation) a déjà été notifiée entre deux comptes, et sa
          date, même après un retrait, un refus ou un blocage. Suivre une association ne demande
          rien à personne.
        </dd>
      </div>
      <div>
        <dt>Associations, cotisations, formulaires et paiements</dt>
        <dd>
          Vos adhésions et rôles, vos cotisations, vos réponses aux formulaires et vos achats
          (montant, produit, statut, identifiant de la transaction chez Lydia). Quand un responsable
          d'association enregistre l'issue d'un paiement non livré (remboursé ou cotisation
          attribuée), Canari garde cette issue, sa date et l'identifiant du responsable. Aucune
          donnée bancaire n'est reçue ni conservée par Canari. Les fichiers déposés dans un
          formulaire (par exemple un CV) sont lisibles par l'association qui l'a créé.
        </dd>
      </div>
      <div>
        <dt>Formulaires publics (réponses sans compte)</dt>
        <dd>
          Une personne sans compte qui répond à un formulaire public laisse ses réponses, et, si le
          formulaire est payant, le montant, le statut du paiement et l'identifiant de la demande
          chez Lydia. L'adresse e-mail saisie pour payer est transmise à Lydia et n'est pas
          conservée par Canari. Pour un paiement en ligne, Canari garde une empreinte du lien de
          retour (jamais le lien lui-même), qui permet de consulter ce paiement. Tant qu'une réponse
          payante attend son paiement, elle porte une empreinte calculée avec une clé secrète (HMAC)
          à partir du formulaire et du réseau de la connexion : l'adresse IPv4, ou le préfixe /64
          d'une adresse IPv6. L'adresse elle-même n'est pas conservée. Cette empreinte sert
          uniquement à limiter à trois les réponses en attente de paiement depuis un même réseau ;
          elle est effacée par une tâche planifiée, dans les cinq minutes qui suivent le règlement,
          l'annulation ou l'expiration de la réponse.
        </dd>
      </div>
      <div>
        <dt>Réservations</dt>
        <dd>
          Lorsque vous réservez un créneau (une salle, un objet, un rendez-vous), Canari enregistre
          la réservation : la ressource, le début et la fin, votre identifiant et le nom affiché au
          moment de la réservation, les participants que vous ajoutez et vos réponses aux questions
          de l'espace. Ces réponses ne sont lisibles que par les organisateurs de l'espace et par
          les administrateurs de la plateforme ; les fichiers que vous joignez (PDF ou image, 8 Mo
          au plus) ne sont téléchargeables que par les organisateurs de l'espace, et sont conservés
          en clair sur nos serveurs, sans chiffrement de bout en bout, pour qu'ils puissent les
          lire. Les autres personnes ne voient votre nom que si l'espace l'affiche, sinon seulement
          « occupé ». L'affiche d'un espace est chiffrée sur l'appareil de l'organisateur, comme
          l'image d'une publication. Un organisateur peut exporter les réservations de son espace
          dans un tableur ; un fichier n'y figure que par un mot, jamais par son contenu. Les
          personnes d'une réservation sont prévenues par une notification de son annulation, d'un
          retrait, d'un ajout et, avant le créneau, par un rappel ; Canari enregistre pour cela le
          délai de rappel que chacun choisit, et l'heure à laquelle ce rappel est parti. Le message
          qu'un organisateur joint à une annulation n'est pas conservé avec la réservation : il ne
          figure que dans la notification. Sur un espace accessible par son seul lien, la
          notification sur l'écran verrouillé ne nomme ni l'espace ni l'organisateur. Dans
          l'application, la notification nomme le lieu (l'espace et la ressource, qui peut porter le
          nom d'une personne ; rien sur un espace accessible par son seul lien) et le début du
          créneau. Ces notifications, message, lieu et début du créneau compris, sont supprimées au
          bout de 90 jours, comme toute notification dans l'application, y compris lorsque l'espace
          a été supprimé entre-temps.
        </dd>
      </div>
      <div>
        <dt>Appareils et notifications</dt>
        <dd>
          Pour chaque appareil : un identifiant, son nom et son système, la version de
          l'application, ses clés publiques de chiffrement et le jeton de notification attribué par
          Google (FCM) ou Apple (APNs), avec la langue de l'appareil.
        </dd>
      </div>
      <div>
        <dt>Présence en ligne</dt>
        <dd>
          Tant qu'un de vos appareils est connecté, le serveur note qu'il est en ligne. En dehors
          des administrateurs de la plateforme, seules les personnes avec qui vous partagez une
          conversation ou une communauté voient si vous êtes en ligne. Un blocage ne masque pas
          cette information.
        </dd>
      </div>
      <div>
        <dt>Appels audio (quand la fonction est ouverte)</dt>
        <dd>
          Le son d'un appel est chiffré de bout en bout entre les deux appareils : ni notre serveur
          ni Cloudflare ne peuvent l'écouter, et aucun appel n'est enregistré. Notre serveur connaît
          en revanche l'appel lui-même : la conversation, qui appelle, qui décroche et depuis quel
          appareil, l'heure et la durée. Il garde l'état d'un appel 4 heures au plus après son
          début, et ses journaux techniques en gardent la trace pendant la durée indiquée en section
          6. Une fois l'appel décroché,
          <strong>les deux appareils échangent leurs adresses IP</strong> par l'intermédiaire de notre
          serveur, pour se connecter directement : votre correspondant peut donc connaître votre adresse
          IP, qui peut indiquer approximativement où vous vous trouvez (ville, fournisseur d'accès, réseau
          de l'École). Chaque appareil contacte aussi les serveurs de connexion de Cloudflare, qui voient
          son adresse IP et l'heure ; quand la connexion directe est impossible, le son, toujours chiffré,
          passe par le relais de Cloudflare (section 4). Un appel que vous ne décrochez pas ne transmet
          votre adresse IP ni à l'appelant ni à Cloudflare. Vous pouvez refuser les appels dans chaque
          conversation, et aucun appel n'est possible entre deux membres dont l'un a bloqué l'autre. La
          conversation garde une ligne « appel » (heure, durée), chiffrée comme vos messages. Pour un
          appel, notre serveur envoie aussi un avis d'appel entrant à chaque appareil d'un membre qui
          accepte les appels dans cette conversation, même si l'application est fermée : il contient en
          clair le nom de l'appelant, le nom de la conversation s'il s'agit d'un groupe, et les identifiants
          techniques de l'appel (sur Android ; sur iPhone, l'alerte affichée est générique, « Appel entrant
          », sans nom). Dans cette version, un appel ne sonne que dans l'application ouverte.
        </dd>
      </div>
      <div>
        <dt>Liens partagés</dt>
        <dd>
          Quand un lien est affiché avec un aperçu, son adresse est envoyée à notre serveur, qui
          récupère lui-même le titre et l'image de la page. Quand vous ouvrez un lien, son adresse
          est vérifiée par Google Safe Browsing (section 4). Le serveur voit donc l'adresse de ces
          liens, même partagés dans une conversation chiffrée.
        </dd>
      </div>
      <div>
        <dt>Signalements, blocages et modération</dt>
        <dd>
          Les signalements que vous faites ou qui vous concernent, les personnes que vous bloquez,
          et les éventuelles mesures de modération. Pour un direct : signaler un message du chat
          transmet son texte, que le serveur vérifie contre le message chiffré avant de le garder,
          signé, pour la modération ; c'est un texte que le serveur ne lisait pas avant le
          signalement. Une coupure par la modération est enregistrée (le direct, la personne qui
          diffusait, l'association, le modérateur, le motif, une note éventuelle de la modération
          qui ne vous est pas montrée, les heures) ; une coupure peut viser un direct en cours ou un
          direct qui vient de se terminer, et celle d'un direct diffusé au nom d'une association
          compte pour la personne qui diffusait. Vous en êtes prévenu sans que le nom du modérateur
          soit indiqué, sauf pour une première coupure d'un direct déjà terminé, qui n'est pas
          notifiée. Toute coupure à partir de la deuxième en 90 jours suspend automatiquement le
          droit de lancer un direct pendant 30 jours à compter de la coupure ; chaque coupure est
          décidée par une personne, jamais par un nombre de signalements. Un retrait du droit de
          diffuser est enregistré de la même façon. Un blocage, dans un sens ou dans l'autre,
          empêche de voir le direct de l'autre et masque ses messages et réactions dans un chat,
          mais il ne retire personne du nombre de spectateurs.
        </dd>
      </div>
      <div>
        <dt>Données techniques</dt>
        <dd>
          Adresse IP, date, requête et navigateur (journaux du serveur) ; pour chaque session, la
          dernière adresse IP, l'appareil et les dates d'usage ; sur Android, la partie publique de
          la clé de restauration de la session (voir « Sessions » ci-dessous).
        </dd>
      </div>
      <div>
        <dt>Cotisations des anciennes bases (personnes sans compte)</dt>
        <dd>
          Pour permettre aux cotisants du BDE et du Cercle d'avant Canari de retrouver leur
          cotisation, Canari conserve une liste d'environ 1 400 personnes : nom, prénom, promotion
          et association. Une ligne est rattachée au compte à la première connexion de la personne.
        </dd>
      </div>
    </dl>
    <p>
      Canari ne collecte pas votre localisation, votre carnet d'adresses ni la liste de vos
      applications, et n'intègre aucun outil de publicité ou de mesure d'audience.
    </p>
  </section>

  <!-- 3 -->
  <section id="finalites">
    <h2>3. Finalités et bases légales</h2>
    <p>
      Chaque traitement repose sur une base légale de l'article 6 du RGPD. Le service que vous
      demandez en vous connectant est un contrat au sens du RGPD (article 6.1.b) : les conditions
      d'utilisation en fixent le contenu.
    </p>
    <div class="legal-table-wrap">
      <table class="legal-table">
        <thead>
          <tr><th>Traitement</th><th>Finalité</th><th>Base légale</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Compte, profil, annuaire</td>
            <td
              >Vous reconnaître, vous permettre de trouver et d'être trouvé par les autres membres</td
            >
            <td>Exécution du service (6.1.b)</td>
          </tr>
          <tr>
            <td>Messagerie, communautés, salons</td>
            <td
              >Acheminer et synchroniser vos messages chiffrés entre vos appareils et vos contacts</td
            >
            <td>Exécution du service (6.1.b)</td>
          </tr>
          <tr>
            <td>Publications, réactions, CanaReels, agenda</td>
            <td>Diffuser ce que vous publiez à l'audience choisie</td>
            <td>Exécution du service (6.1.b)</td>
          </tr>
          <tr>
            <td>Directs, chat et réactions</td>
            <td
              >Diffuser un direct aux membres autorisés et prévenir vos abonnés ; conserver votre
              acceptation des règles du direct, condition pour en lancer un</td
            >
            <td>Exécution du service (6.1.b)</td>
          </tr>
          <tr>
            <td>Appels audio</td>
            <td>Établir un appel chiffré entre deux membres d'une conversation</td>
            <td>Exécution du service (6.1.b)</td>
          </tr>
          <tr>
            <td>Notifications push</td>
            <td>Vous prévenir d'un message, d'une activité ou d'un appel</td>
            <td>Exécution du service (6.1.b) ; désactivables depuis l'appareil</td>
          </tr>
          <tr>
            <td>Associations, cotisations, formulaires, paiements</td>
            <td>Gérer vos adhésions, vos inscriptions et vos achats auprès des associations</td>
            <td>
              Exécution du service (6.1.b) ; conservation des pièces comptables : obligation légale
              (6.1.c)
            </td>
          </tr>
          <tr>
            <td>Réservations</td>
            <td>Réserver une salle, un objet ou un rendez-vous auprès d'un organisateur</td>
            <td>Exécution du service (6.1.b)</td>
          </tr>
          <tr>
            <td>Aperçus de liens et vérification Safe Browsing</td>
            <td>Afficher un aperçu ; vous avertir avant d'ouvrir un lien dangereux</td>
            <td>Intérêt légitime (6.1.f) : protéger les membres contre l'hameçonnage</td>
          </tr>
          <tr>
            <td>Signalements, blocages, modération</td>
            <td>Faire respecter les conditions d'utilisation, y compris pendant les directs</td>
            <td>Intérêt légitime (6.1.f) : la sécurité de la communauté</td>
          </tr>
          <tr>
            <td>Journaux techniques, sécurité des sessions</td>
            <td>Détecter les abus, diagnostiquer les pannes</td>
            <td>Intérêt légitime (6.1.f) : la sécurité du service</td>
          </tr>
          <tr>
            <td>Cotisations des anciennes bases</td>
            <td>Rendre aux anciens cotisants la cotisation déjà payée</td>
            <td>Intérêt légitime (6.1.f) des associations et des cotisants</td>
          </tr>
          <tr>
            <td>Environnement de test</td>
            <td>Vérifier une nouvelle version avant sa mise en production (section 8)</td>
            <td>Intérêt légitime (6.1.f) : la fiabilité du service</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p>
      Les données de profil transmises par MiConnect sont nécessaires à l'ouverture du compte : sans
      elles, le service ne peut pas être fourni. Canari ne prend aucune décision automatisée
      produisant des effets juridiques à votre égard. Vos données ne sont ni vendues, ni louées, ni
      utilisées à des fins publicitaires. Vous pouvez vous opposer à un traitement fondé sur
      l'intérêt légitime (section 10).
    </p>
  </section>

  <!-- 4 -->
  <section id="tiers">
    <h2>4. Destinataires et sous-traitants</h2>
    <p>
      À l'intérieur de Canari, vos données sont visibles des membres selon ce que vous partagez, et
      des responsables d'une association pour ce qui la concerne (membres, réponses à ses
      formulaires, achats). Hors de Canari, seuls les destinataires suivants reçoivent des données,
      chacun pour sa mission :
    </p>
    <ul class="legal-terms">
      <li>
        <p class="legal-block-title">
          Google Firebase Cloud Messaging et Apple Push Notification service
        </p>
        <p>
          Acheminent les notifications vers votre téléphone (Google LLC et Apple Inc., États-Unis).
          Google reçoit le jeton de l'appareil et la notification elle-même : le message chiffré, et
          <strong>en clair</strong> le nom de l'expéditeur et le nom du groupe ou du salon. Apple reçoit
          le jeton et le titre affiché (nom de l'expéditeur ou du groupe). Pour une activité sur le fil
          (commentaire, mention, événement), la notification contient aussi en clair le nom de l'auteur
          et le début du texte, 60 caractères au plus. Ce choix technique permet d'afficher une notification
          lisible ; le contenu des messages privés n'y figure jamais en clair. Quand une personne ou une
          association que vous suivez lance un direct, la notification contient en clair son nom et des
          identifiants techniques (le direct, l'association, l'image affichée), sans autre texte ; un
          avis de coupure, de suspension ou de retrait du droit de diffuser est une phrase fixe, sans
          nom.
        </p>
      </li>
      <li>
        <p class="legal-block-title">Lydia - paiements (« Paiement Canari »)</p>
        <p>
          Prestataire de paiement français. Il reçoit le montant, le nom des produits et l'adresse
          e-mail que vous saisissez pour recevoir la demande de paiement ; cette adresse n'est pas
          conservée par Canari. Vos coordonnées bancaires sont traitées uniquement par Lydia.
        </p>
      </li>
      <li>
        <p class="legal-block-title">Google Safe Browsing</p>
        <p>
          Quand vous ouvrez un lien, notre serveur envoie son adresse complète à Google (Google LLC,
          États-Unis) pour savoir s'il est signalé comme dangereux. Aucune donnée vous identifiant
          n'accompagne la demande : Google voit l'adresse du lien et notre serveur.
        </p>
      </li>
      <li>
        <p class="legal-block-title">KLIPY - recherche de GIF</p>
        <p>
          Quand vous cherchez un GIF, votre recherche passe par notre serveur, qui l'envoie à KLIPY
          sans aucune donnée vous identifiant. Les GIF de KLIPY eux-mêmes - dans le sélecteur, dans
          les conversations et dans les commentaires - sont aussi chargés par notre serveur : KLIPY
          voit la recherche et l'adresse de notre serveur, jamais votre adresse IP ni votre compte.
          L'adresse complète d'un GIF ainsi relayé figure dans les journaux techniques de notre
          serveur web et de Cloudflare. Un GIF venant d'un autre site (lien collé) est chargé
          directement depuis ce site par votre appareil. Une version de l'application antérieure à
          celle qui contient ce relais charge encore les GIF directement chez KLIPY, avec l'adresse
          IP de votre appareil, jusqu'à sa mise à jour.
        </p>
      </li>
      <li>
        <p class="legal-block-title">Cloudflare</p>
        <p>
          Les anciens noms de domaine encore utilisés par d'anciennes versions de l'application
          (canari-emse.fr et dev.canari-emse.fr) passent par Cloudflare (Cloudflare Inc.,
          États-Unis), qui voit alors les requêtes, votre adresse IP et les données transmises hors
          contenu chiffré. Le nom principal, canari.emse.fr, ne passe pas par Cloudflare.
        </p>
        <p>
          Pour les appels, Cloudflare (Cloudflare Inc., États-Unis) fournit aussi des serveurs de
          connexion (STUN) et un relais (TURN). Une fois un appel décroché, chaque appareil les
          contacte pour établir la connexion : Cloudflare voit alors son adresse IP et l'heure.
          Quand les deux appareils ne peuvent pas se joindre directement, le son passe par ce
          relais, qui voit aussi l'adresse IP de l'autre appareil, la durée et le volume échangé,
          mais jamais le son, chiffré de bout en bout. Notre serveur obtient pour chaque appel un
          accès temporaire au relais sans transmettre à Cloudflare aucun identifiant de compte.
        </p>
      </li>
      <li>
        <p class="legal-block-title">Services de l'écosystème</p>
        <p>
          <strong>MiConnect</strong> (connexion) transmet votre profil à Canari.
          <strong>MiGallery</strong> (association MiTV) fournit les photos de profil.
          <strong>Le Cercle</strong> reçoit, pour un rechargement de votre solde au bar, l'identifiant
          du compte, le montant et la référence du paiement.
        </p>
      </li>
      <li>
        <p class="legal-block-title">Hébergement</p>
        <p>
          La direction des systèmes d'information (DSI) de l'École, qui administre le serveur
          partagé sur lequel Canari est installé (section 8).
        </p>
      </li>
    </ul>
  </section>

  <!-- 5 -->
  <section id="transferts">
    <h2>5. Transferts hors de l'Union européenne</h2>
    <p>
      Les serveurs de Canari sont en France. Les destinataires américains de la section 4 (Google,
      Apple, Cloudflare) et KLIPY peuvent traiter les données qu'ils reçoivent hors de l'Union
      européenne. Les garanties qui encadrent chacun de ces transferts (cadre de protection des
      données UE-États-Unis ou clauses contractuelles types de la Commission européenne) sont en
      cours de vérification auprès de chaque prestataire ; cette section sera complétée dès qu'elles
      seront documentées. Vous pouvez en demander l'état à l'adresse de contact.
    </p>
  </section>

  <!-- 6 -->
  <section id="retention">
    <h2>6. Durées de conservation</h2>
    <div class="legal-table-wrap">
      <table class="legal-table">
        <thead>
          <tr><th>Données</th><th>Durée</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Compte et profil</td>
            <td>
              Tant que le compte existe ; supprimés à la suppression du compte (une nouvelle
              connexion recrée un compte)
            </td>
          </tr>
          <tr>
            <td>Sessions de connexion, et leur clé de restauration sur Android</td>
            <td>7 jours sans utilisation ; la clé disparaît avec sa session</td>
          </tr>
          <tr>
            <td>Présence en ligne</td>
            <td>Effacée à la déconnexion de l'appareil, 90 secondes au plus après</td>
          </tr>
          <tr>
            <td>Messages privés en attente de remise (chiffrés)</td>
            <td>Supprimés dès la remise à l'appareil, 90 jours au plus</td>
          </tr>
          <tr>
            <td>Historique chiffré d'une conversation sur le serveur</td>
            <td>90 jours au plus</td>
          </tr>
          <tr>
            <td>Messages de salon (chiffrés)</td>
            <td>365 jours, sauf messages épinglés ; ou jusqu'à leur suppression</td>
          </tr>
          <tr>
            <td>Trace d'un message de salon supprimé (auteur, identifiant aléatoire)</td>
            <td>
              30 jours après la suppression du message ; avant, avec le salon ou le compte de
              l'auteur
            </td>
          </tr>
          <tr>
            <td>Fichiers envoyés dans une conversation (chiffrés)</td>
            <td>
              90 jours sans consultation ; CanaReels de conversation : 30 jours. Les fichiers
              envoyés avant octobre 2026, ou par une version de l'application antérieure, sont pour
              l'instant conservés sans limite
            </td>
          </tr>
          <tr>
            <td>Publications, commentaires, médias des publications</td>
            <td>Jusqu'à leur suppression ou celle du compte ; CanaReels du fil : 30 jours</td>
          </tr>
          <tr>
            <td>Direct : vidéo chiffrée, chat, réactions, spectateurs retirés</td>
            <td>
              Supprimés à la fin du direct (par vous, après 60 secondes sans vidéo, au bout d'une
              heure, par une coupure de la modération ou à la suppression de votre compte). Après
              une coupure, la vidéo est supprimée aussitôt ; après la suppression du compte, dans
              les 30 secondes ; à une autre fin, elle l'est une fois que les derniers spectateurs
              ont fini de la recevoir, en principe dans la minute. Une suppression qui échoue est
              reprise toutes les 30 secondes. Un segment mis en cache par notre serveur web ou par
              l'appareil d'un spectateur : deux minutes au plus après sa dernière lecture
            </td>
          </tr>
          <tr>
            <td>Place de spectateur (votre compte, l'heure de votre dernière lecture)</td>
            <td>
              Effacée quand vous quittez le direct, 30 secondes au plus après votre dernière
              lecture, et à la fin du direct
            </td>
          </tr>
          <tr>
            <td>Heure de chaque démarrage d'un direct</td>
            <td>Une heure</td>
          </tr>
          <tr>
            <td>Message du chat d'un direct signalé</td>
            <td>
              Jusqu'au traitement du signalement, 90 jours au plus, y compris si son auteur supprime
              son compte entre-temps (le message est alors détaché du compte)
            </td>
          </tr>
          <tr>
            <td>Coupure d'un direct par la modération</td>
            <td
              >90 jours ; elle compte pendant ce délai dans les sanctions des conditions
              d'utilisation</td
            >
          </tr>
          <tr>
            <td>Retrait du droit de lancer un direct</td>
            <td>Jusqu'à ce que la modération le lève, ou jusqu'à la suppression du compte</td>
          </tr>
          <tr>
            <td>Acceptation des règles du direct</td>
            <td>Tant que le compte existe</td>
          </tr>
          <tr>
            <td>Abonnements et demandes d'abonnement</td>
            <td>
              Une demande : jusqu'à sa réponse (un refus la supprime), son retrait, un blocage (elle
              est aussitôt masquée, puis supprimée) ou la suppression d'un des deux comptes ; un
              abonnement : jusqu'à son retrait par l'un ou l'autre, un blocage (il est aussitôt
              masqué, puis supprimé) ou la suppression d'un des deux comptes ; la trace qu'une
              notification a été envoyée : jusqu'à la suppression d'un des deux comptes
            </td>
          </tr>
          <tr>
            <td>Documents d'une association</td>
            <td
              >Tant que l'association les conserve, y compris après la suppression du compte qui les
              a déposés</td
            >
          </tr>
          <tr>
            <td>Fichiers déposés dans un formulaire</td>
            <td>
              1 à 30 jours selon le formulaire (7 jours par défaut), puis jusqu'à 6 mois dans les
              sauvegardes
            </td>
          </tr>
          <tr>
            <td>Réponses aux formulaires</td>
            <td>Aucune durée n'est encore fixée : elle est en cours de définition</td>
          </tr>
          <tr>
            <td>
              Empreinte (HMAC) du réseau d'une réponse payante sans compte (adresse IPv4 ou préfixe
              /64 IPv6, jamais l'adresse elle-même)
            </td>
            <td>
              Tant que la réponse attend son paiement (30 minutes en ligne, jusqu'à l'échéance fixée
              pour un paiement en espèces), puis effacée dans les cinq minutes
            </td>
          </tr>
          <tr>
            <td>Réponses et fichiers d'une réservation</td>
            <td>
              Supprimés automatiquement N jours après la fin du créneau (N est choisi par
              l'organisateur, entre 1 et 30 jours, 7 par défaut, et indiqué sous chaque question «
              fichier ») ; un fichier envoyé sans réservation est supprimé après un jour ; les
              fichiers subsistent ensuite jusqu'à 6 mois dans les sauvegardes
            </td>
          </tr>
          <tr>
            <td>Réservations (créneau, nom affiché, participants)</td>
            <td>Supprimées un an après la fin du créneau</td>
          </tr>
          <tr>
            <td>Jeton de notification</td>
            <td
              >Supprimé à la déconnexion ou à la suppression du compte ; 90 jours au plus sans
              renouvellement</td
            >
          </tr>
          <tr>
            <td>État d'un appel sur le serveur (conversation, appelant, appareils, heure)</td>
            <td>
              4 heures au plus après le début de l'appel ; les journaux techniques en gardent la
              trace selon la ligne « Journaux techniques » ci-dessous
            </td>
          </tr>
          <tr>
            <td>Notifications dans l'application</td>
            <td>90 jours</td>
          </tr>
          <tr>
            <td>Signalements</td>
            <td>90 jours après leur traitement</td>
          </tr>
          <tr>
            <td>Achats et paiements</td>
            <td>
              Conservés pour la comptabilité des associations ; détachés de votre compte à sa
              suppression. Lydia conserve ses propres données selon sa politique.
            </td>
          </tr>
          <tr>
            <td>Journaux techniques (IP, date, requête)</td>
            <td
              >90 jours au plus ; cette limite est en cours de mise en place sur l'ensemble des
              journaux</td
            >
          </tr>
          <tr>
            <td>Cotisations des anciennes bases</td>
            <td>
              Conservées sans date de fin pour l'instant, le temps que les anciens cotisants
              puissent les récupérer ; cette durée est en cours de réexamen
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="legal-note">
      <p class="legal-callout-title">Sauvegardes</p>
      <p>
        La base de données est sauvegardée chaque nuit et chaque sauvegarde est gardée 14 jours :
        une donnée supprimée peut donc subsister jusqu'à 14 jours dans les sauvegardes, puis
        disparaît. Les fichiers sont sauvegardés à part, dans un dépôt chiffré, avec des copies
        quotidiennes, hebdomadaires et mensuelles : un fichier supprimé peut y subsister
        <strong>jusqu'à 6 mois</strong>. La plupart des fichiers sont chiffrés sur votre appareil
        avant l'envoi ; les fichiers déposés dans un formulaire et les logos des associations ne le
        sont pas. Un direct en cours au moment d'une sauvegarde nocturne peut y laisser ses lignes
        de base de données (dont le chat chiffré et la clé du direct, elle-même chiffrée par un
        secret du serveur qui n'est pas dans la base) et des segments chiffrés, pour les durées
        ci-dessus. Une sauvegarde n'est relue que pour restaurer le service.
      </p>
    </div>
  </section>

  <!-- 7 -->
  <section id="local">
    <h2>7. Cookies et stockage local</h2>
    <p>
      Canari n'utilise aucun cookie publicitaire ni de mesure d'audience. Ce qu'il enregistre dans
      votre navigateur ou sur votre appareil sert au fonctionnement du service, à une exception
      près, signalée dans le tableau :
    </p>
    <div class="legal-table-wrap">
      <table class="legal-table">
        <thead>
          <tr><th>Élément</th><th>Rôle</th><th>Durée</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Cookie <code>canari_refresh</code> (inaccessible au code de la page)</td>
            <td>Garder votre session ouverte</td>
            <td>7 jours</td>
          </tr>
          <tr>
            <td>Cookie <code>canari_ws_token</code></td>
            <td>Authentifier la connexion temps réel</td>
            <td>Fermeture du navigateur ; jeton valable 1 heure</td>
          </tr>
          <tr>
            <td>Cookie <code>canari_adminer</code> (administrateurs seulement)</td>
            <td>Accès à l'outil d'administration de la base</td>
            <td>Session</td>
          </tr>
          <tr>
            <td>Base locale de l'application (IndexedDB, SQLite sur mobile)</td>
            <td>
              Vos messages, l'état de chiffrement et la file d'envoi, chiffrés par une clé protégée
              par votre code PIN ; la liste des conversations (noms, dates) n'est pas chiffrée
            </td>
            <td
              >Sur l'appareil, jusqu'à l'effacement des données de l'application ou sa
              désinstallation</td
            >
          </tr>
          <tr>
            <td>Préférences et brouillons (stockage local)</td>
            <td>Thème, émojis récents, brouillon de publication, identifiant de l'appareil</td>
            <td>Jusqu'à leur effacement</td>
          </tr>
          <tr>
            <td>Raccourcis de conversation (application Android)</td>
            <td>
              Les noms de vos conversations récentes, et leur identifiant interne, sont confiés au
              système Android pour les proposer dans son menu Partager (désactivable dans Paramètres
              &gt; Préférences) ; les notifications de message y confient aussi le nom et la photo
              de la conversation. Le système et l'écran d'accueil peuvent donc les afficher
            </td>
            <td
              >Effacés à la déconnexion (les suggestions aussi à la désactivation du réglage) ou à
              la désinstallation. Un raccourci que vous avez épinglé sur l'écran d'accueil ne peut
              pas être retiré par l'application : il est désactivé, et c'est le lanceur qui décide
              s'il reste affiché</td
            >
          </tr>
          <tr>
            <td>Identifiant aléatoire <code>klipy_cid</code></td>
            <td>
              Créé par les versions de l'application antérieures à octobre 2026, qui l'envoyaient à
              KLIPY avec les recherches de GIF (section 4). La version actuelle ne l'utilise plus et
              l'efface au démarrage
            </td>
            <td>Jusqu'au premier démarrage d'une version à jour</td>
          </tr>
          <tr>
            <td>Journal de l'application</td>
            <td
              >Diagnostic ; expurgé des jetons et adresses, il ne quitte l'appareil que si vous
              l'exportez</td
            >
            <td>2 Mo, les lignes les plus anciennes sont effacées</td>
          </tr>
          <tr>
            <td>Trousseau sécurisé du téléphone</td>
            <td>La clé de votre appareil</td>
            <td>Jusqu'à la désinstallation</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <!-- 8 -->
  <section id="stockage">
    <h2>8. Hébergement et sécurité</h2>
    <dl class="legal-terms">
      <div>
        <dt>Hébergement</dt>
        <dd>
          Canari fonctionne sur un serveur partagé de l'École des Mines de Saint-Étienne, en France,
          administré avec la DSI de l'École. Les sauvegardes sont copiées sur une seconde machine de
          l'École. Les anciens noms de domaine passent encore par Cloudflare (section 4), de même
          que les appels audio dans la mesure décrite en sections 2 et 4.
        </dd>
      </div>
      <div>
        <dt>Environnement de test</dt>
        <dd>
          Une version de test (dev.canari-emse.fr), sur le même serveur, sert à vérifier chaque
          nouvelle version avant sa diffusion. Elle ne contient aucune donnée de la production : des
          personnes et des associations fictives, et ce que les testeurs y créent eux-mêmes. Seuls
          les comptes MiConnect peuvent s'y connecter.
        </dd>
      </div>
      <div>
        <dt>Chiffrement de bout en bout</dt>
        <dd>
          Les messages, les fichiers et les réactions des conversations sont chiffrés sur votre
          appareil. Le serveur ne détient aucune clé permettant de les lire. Il en va de même du son
          des appels audio, chiffré entre les deux appareils. Les directs, eux, ne sont pas chiffrés
          de bout en bout (section 2).
        </dd>
      </div>
      <div>
        <dt>Sessions</dt>
        <dd>
          Le jeton d'accès vit en mémoire et expire au bout d'une heure ; le jeton qui renouvelle la
          session est conservé dans un cookie inaccessible au code de la page (ou dans le stockage
          de l'application sur iPhone, Mac et Linux). Sur Android, l'application crée une clé de
          restauration que le système du téléphone sauvegarde avec votre sauvegarde Google : un
          nouveau téléphone restauré depuis cette sauvegarde reprend la session sans nouvelle
          connexion, et l'ancien téléphone en est alors déconnecté. Canari ne conserve que la partie
          publique de cette clé, rattachée à la session ; elle disparaît avec la session
          (déconnexion, 7 jours sans utilisation, suppression du compte). Canari n'envoie rien à
          Google : la clé est créée et sauvegardée par le téléphone lui-même.
        </dd>
      </div>
      <div>
        <dt>Transmission</dt>
        <dd>Toutes les communications sont chiffrées (TLS 1.2 au minimum).</dd>
      </div>
    </dl>
  </section>

  <!-- 9 -->
  <section id="age">
    <h2>9. Âge minimum et mineurs</h2>
    <p>
      Canari est réservé aux membres de la communauté de l'École des Mines de Saint-Étienne qui
      disposent d'un compte MiConnect. <strong
        >Il n'est pas destiné aux personnes de moins de 15 ans</strong
      >
      : cet âge minimum est fixé par référence à l'article 45 de la loi Informatique et Libertés. Un élève
      mineur de 15 ans ou plus peut utiliser Canari et exercer lui-même ses droits (section 10). Si vous
      pensez qu'une personne de moins de 15 ans utilise Canari, écrivez à
      <a href="mailto:bureau@rootz-emse.fr">bureau@rootz-emse.fr</a> : son compte sera supprimé.
    </p>
  </section>

  <!-- 10 -->
  <section id="droits">
    <h2>10. Vos droits et comment les exercer</h2>
    <p>Conformément au RGPD, vous disposez des droits suivants :</p>
    <dl class="legal-terms">
      {#each [['Accès et copie', 'Obtenir la confirmation que nous traitons vos données et une copie de celles-ci.'], ['Portabilité', 'Recevoir les données que vous nous avez fournies dans un format structuré et lisible par machine (JSON).'], ['Rectification', "Corriger une donnée inexacte. Le nom, le prénom et le profil venant de MiConnect se corrigent dans MiConnect ou par une demande de correction dans l'application."], ['Effacement', 'Supprimer votre compte vous-même ou nous le demander (voir ci-dessous).'], ['Limitation', 'Demander le gel temporaire du traitement de vos données.'], ['Opposition', "Vous opposer à un traitement fondé sur l'intérêt légitime, par exemple à la conservation de votre ligne dans les cotisations des anciennes bases."], ['Directives après le décès', "Définir des directives sur la conservation, l'effacement et la communication de vos données après votre décès (article 85 de la loi Informatique et Libertés)."]] as [droit, desc], i (i)}
        <div>
          <dt>{droit}</dt>
          <dd>{desc}</dd>
        </div>
      {/each}
    </dl>

    <div class="legal-note">
      <p class="legal-callout-title">Supprimer votre compte</p>
      <p>
        Depuis l'application : <strong>Paramètres > Supprimer mon compte</strong>. La suppression
        est immédiate : profil, publications, adhésions, appareils, jetons de notification, messages
        en attente et messages de salon (avec leurs réactions et épingles) sont effacés. Vos achats
        sont conservés sous une forme détachée de votre compte (auteur « supprimé »), pour ne pas
        trouer la comptabilité des associations. Vos réservations à venir sont annulées, vos
        réponses et vos fichiers de réservation sont supprimés, et votre identifiant est effacé des
        réservations passées, qui gardent le nom affiché jusqu'à leur suppression à un an. Vos
        espaces de réservation personnels sont supprimés avec tout ce qu'ils contiennent, y compris
        les réservations à venir d'autres personnes, qui n'en sont pas prévenues ; l'affiche d'un
        espace d'association est conservée, elle appartient à l'association. Un direct que vous
        diffusez s'arrête et ses données sont supprimées ; vos messages et réactions dans les
        directs, vos coupures, votre retrait éventuel et votre acceptation des règles du direct sont
        effacés, sauf un message signalé, gardé détaché de votre compte jusqu'au traitement du
        signalement (90 jours au plus). Certaines données ne sont pas encore atteintes par cette
        suppression, notamment vos réponses aux formulaires, vos commentaires et réactions sur les
        publications d'autres membres et l'historique des modifications de votre profil : leur
        intégration est en cours, et vous pouvez en demander l'effacement par e-mail dès maintenant.
      </p>
      <p class="legal-fineprint">
        Les données supprimées subsistent dans les sauvegardes pendant la durée indiquée en section
        6. Désinstaller l'application ne supprime pas le compte.
      </p>
    </div>

    <div class="legal-block">
      <p class="legal-block-title">Exercer un autre droit</p>
      <p>
        Écrivez à <a href="mailto:bureau@rootz-emse.fr">bureau@rootz-emse.fr</a>
        en indiquant le droit exercé et votre identifiant de connexion, de préférence depuis votre adresse
        e-mail de l'École. Nous pouvons vous demander de confirmer la demande depuis votre compte avant
        d'y répondre. Nous répondons <strong>dans un délai de 30 jours</strong> ; si la demande est complexe,
        ce délai peut être prolongé de deux mois, et nous vous en informons dans les 30 jours. La copie
        de vos données vous est envoyée par e-mail au format JSON. Le contenu de vos messages chiffrés
        n'est lisible que sur vos appareils : sa sauvegarde se fait depuis l'application (Paramètres >
        Sauvegarde).
      </p>
    </div>

    <p>
      Si vous estimez que vos droits ne sont pas respectés, vous pouvez introduire une réclamation
      auprès de la <strong>CNIL</strong>
      (<a href="https://www.cnil.fr" target="_blank" rel="noopener">www.cnil.fr</a>).
    </p>
  </section>

  <!-- 11 -->
  <section id="violation">
    <h2>11. Violation de données</h2>
    <p>
      En cas de violation de données susceptible d'engendrer un risque pour vos droits et libertés,
      l'association Rootz la notifie à la CNIL dans les 72 heures après en avoir pris connaissance
      (article 33 du RGPD). Si le risque est élevé, vous en êtes informé directement et dans les
      meilleurs délais (article 34 du RGPD).
    </p>
  </section>

  <!-- 12 -->
  <section id="modifications">
    <h2>12. Modifications de la politique</h2>
    <p>
      Cette politique est mise à jour quand le service ou la loi change. En cas de modification
      substantielle, vous en êtes informé dans l'application au moins 15 jours avant son entrée en
      vigueur. La date de « Dernière mise à jour » en haut de cette page indique la version en
      vigueur.
    </p>
  </section>

  <!-- 13 -->
  <section id="contact">
    <h2>13. Contact</h2>
    <div class="legal-block">
      <p><strong>Association Rootz - EMSE</strong></p>
      <p>
        Maison des Élèves de l'École des Mines, 20 Boulevard Alexandre de Fraissinette, 42100
        Saint-Étienne
      </p>
      <p>
        <a href="mailto:bureau@rootz-emse.fr">bureau@rootz-emse.fr</a>
      </p>
    </div>
  </section>
</LegalDocument>
