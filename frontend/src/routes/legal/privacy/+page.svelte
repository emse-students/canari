<script lang="ts">
  import LegalDocument from '$lib/components/legal/LegalDocument.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * The document's own sections, in order. Numbered here because the DOCUMENT numbers
   * them - the rail renders the label verbatim and never counts.
   */
  const sections = [
    { id: 'qui', label: '1. Qui sommes-nous' },
    { id: 'collecte', label: '2. Données collectées' },
    { id: 'tiers', label: '3. Sous-traitants et tiers' },
    { id: 'utilisation', label: '4. Utilisation des données' },
    { id: 'retention', label: '5. Durée de conservation' },
    { id: 'stockage', label: '6. Stockage et sécurité' },
    { id: 'transferts', label: '7. Transferts internationaux' },
    { id: 'age', label: '8. Âge minimum' },
    { id: 'droits', label: '9. Vos droits (RGPD)' },
    { id: 'modifications', label: '10. Modifications' },
    { id: 'contact', label: '11. Contact' },
  ];
</script>

<svelte:head>
  <title>{m.legal_privacy_title()} - Canari</title>
</svelte:head>

<LegalDocument
  title={m.legal_privacy_title()}
  subtitle={m.legal_privacy_subtitle()}
  updated="21/05/2026"
  {sections}
>
  <!-- 1 -->
  <section id="qui">
    <h2>1. Qui sommes-nous</h2>
    <p>
      <strong>Canari</strong> est une application de messagerie sécurisée développée pour les
      étudiants de l'École des Mines de Saint-Étienne (EMSE) par l'association
      <strong>Rootz</strong>.
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
      iOS, bureau Windows/macOS/Linux, web) et à l'infrastructure backend associée.
    </p>
  </section>

  <!-- 2 -->
  <section id="collecte">
    <h2>2. Données collectées</h2>
    <p>Canari collecte uniquement les données nécessaires au fonctionnement du service :</p>
    <dl class="legal-terms">
      {#each [['Identité', "Prénom, nom, adresse e-mail et photo de profil transmis par le portail d'authentification OIDC de l'École des Mines (Authentik). Canari ne traite ni ne stocke jamais votre mot de passe."], ['Messages privés', "Vos messages sont chiffrés de bout en bout via le protocole MLS (RFC 9420) avant d'être envoyés. Le serveur ne stocke que des blobs chiffrés et est techniquement incapable de lire le contenu de vos conversations."], ['Publications et commentaires', 'Posts, réactions et commentaires créés volontairement sur la plateforme. Ces contenus sont visibles par les membres de la communauté EMSE.'], ['Jeton de notification push', "Jeton FCM (Firebase Cloud Messaging) de votre appareil, utilisé pour l'envoi de notifications. Stocké côté serveur et supprimé à la déconnexion ou à la suppression du compte."], ['Données de paiement', 'Pour les paiements (formulaires, événements), Canari fait appel à Stripe. Canari ne stocke aucune donnée bancaire - numéro de carte, IBAN ou CVV. Ces données sont traitées directement par Stripe (voir section 3).'], ['Logs techniques', 'Adresse IP et horodatage des requêtes HTTP, conservés temporairement à des fins de sécurité et de débogage.']] as [titre, desc], i (i)}
        <div>
          <dt>{titre}</dt>
          <dd>{desc}</dd>
        </div>
      {/each}
    </dl>
    <p>
      Canari ne collecte pas de données de localisation, d'historique de navigation, de liste
      d'applications installées, ni aucune autre donnée non listée ici.
    </p>
  </section>

  <!-- 3 -->
  <section id="tiers">
    <h2>3. Sous-traitants et tiers</h2>
    <p>
      Canari fait appel à des sous-traitants pour deux fonctionnalités spécifiques. Ces prestataires
      ne reçoivent que les données strictement nécessaires à leur mission.
    </p>
    <ul class="legal-terms">
      <li>
        <p class="legal-block-title">Google Firebase (FCM) - Notifications push</p>
        <p>
          Firebase Cloud Messaging (Google LLC, Mountain View, CA, USA) est utilisé pour l'envoi de
          notifications push sur mobile. Le jeton FCM de votre appareil est transmis aux serveurs
          Google pour acheminer les notifications. Ce transfert est couvert par les clauses
          contractuelles types UE-US (section 7). Politique de confidentialité Google :
          <a href="https://policies.google.com/privacy" target="_blank" rel="noopener"
            >policies.google.com/privacy</a
          >.
        </p>
      </li>
      <li>
        <p class="legal-block-title">Stripe - Traitement des paiements</p>
        <p>
          Stripe, Inc. (South San Francisco, CA, USA) traite les paiements effectués via les
          formulaires et événements payants. Lorsque vous effectuez un paiement, vos données
          financières sont transmises directement à Stripe ; Canari ne reçoit et ne stocke jamais
          vos coordonnées bancaires. Stripe est certifié PCI DSS niveau 1. Politique de
          confidentialité Stripe :
          <a href="https://stripe.com/fr/privacy" target="_blank" rel="noopener"
            >stripe.com/fr/privacy</a
          >.
        </p>
      </li>
    </ul>
    <p>
      Canari ne vend, ne loue et ne partage pas vos données personnelles avec d'autres tiers à des
      fins commerciales ou publicitaires. Aucun SDK de tracking, d'analytics tiers ou de publicité
      n'est intégré à l'application.
    </p>
  </section>

  <!-- 4 -->
  <section id="utilisation">
    <h2>4. Utilisation des données</h2>
    <p>Vos données sont utilisées exclusivement pour :</p>
    <ul>
      <li>Vous authentifier et maintenir votre session active</li>
      <li>Acheminer vos messages chiffrés vers leurs destinataires</li>
      <li>Afficher votre profil aux autres membres de la plateforme</li>
      <li>Vous envoyer des notifications push liées à votre activité sur Canari</li>
      <li>Traiter les paiements que vous initiez (via Stripe)</li>
      <li>Assurer la sécurité, la stabilité et le débogage du service</li>
    </ul>
    <p>
      Les données collectées pour une finalité ne sont pas réutilisées pour une autre finalité sans
      votre consentement explicite.
    </p>
  </section>

  <!-- 5 -->
  <section id="retention">
    <h2>5. Durée de conservation</h2>
    <dl class="legal-terms">
      {#each [['Données de profil', "Conservées pendant toute la durée d'activité de votre compte. Supprimées dans les 30 jours suivant une demande de suppression de compte."], ['Messages privés (blobs chiffrés)', "Conservés jusqu'à suppression par l'utilisateur ou suppression du compte. Les messages supprimés sont effacés définitivement des serveurs."], ['Publications et commentaires', "Conservés jusqu'à suppression manuelle ou suppression du compte."], ['Jeton FCM', 'Supprimé immédiatement à la déconnexion ou à la révocation du compte.'], ['Logs techniques (IP, horodatage)', 'Conservés au maximum 90 jours à des fins de sécurité, puis supprimés automatiquement.'], ['Données de paiement (Stripe)', 'Conservées par Stripe selon leur propre politique (généralement 7 ans pour la conformité fiscale). Canari conserve uniquement un identifiant de transaction Stripe à des fins comptables.']] as [titre, desc], i (i)}
        <div>
          <dt>{titre}</dt>
          <dd>{desc}</dd>
        </div>
      {/each}
    </dl>
  </section>

  <!-- 6 -->
  <section id="stockage">
    <h2>6. Stockage et sécurité</h2>
    <dl class="legal-terms">
      {#each [['Chiffrement de bout en bout', "Tous les messages privés sont chiffrés via MLS (RFC 9420). Le serveur ne dispose d'aucune clé permettant de les déchiffrer."], ["Token d'accès", 'Votre token JWT est conservé en mémoire uniquement (jamais dans le localStorage ou les cookies persistants) et expire après 15 minutes.'], ['Données locales', "L'état MLS est stocké localement sur votre appareil dans une base de données chiffrée."], ['Hébergement principal', "Toutes les données résident sur des serveurs situés à Saint-Étienne, sous le contrôle exclusif de l'association Rootz. Aucun cloud public européen ou américain n'est utilisé pour le stockage principal."], ['Transmission', 'Toutes les communications entre votre appareil et nos serveurs sont chiffrées via TLS 1.2 minimum.']] as [titre, desc], i (i)}
        <div>
          <dt>{titre}</dt>
          <dd>{desc}</dd>
        </div>
      {/each}
    </dl>
  </section>

  <!-- 7 -->
  <section id="transferts">
    <h2>7. Transferts internationaux</h2>
    <p>
      Les données hébergées sur les serveurs de l'association Rootz restent en France
      (Saint-Étienne). Cependant, deux transferts vers des pays tiers peuvent avoir lieu dans le
      cadre des sous-traitants décrits à la section 3 :
    </p>
    <dl class="legal-terms">
      <div>
        <dt>Google Firebase (FCM) - États-Unis</dt>
        <dd>
          <p>
            Le jeton FCM est transmis aux serveurs de Google LLC aux États-Unis. Ce transfert est
            encadré par les clauses contractuelles types (CCT) adoptées par la Commission européenne
            conformément à l'article 46 du RGPD.
          </p>
        </dd>
      </div>
      <div>
        <dt>Stripe - États-Unis</dt>
        <dd>
          <p>
            Les données de paiement sont traitées par Stripe Inc. aux États-Unis. Ce transfert est
            également encadré par les CCT. Stripe est en outre certifié PCI DSS et adhère au cadre
            EU-US Data Privacy Framework.
          </p>
        </dd>
      </div>
    </dl>
  </section>

  <!-- 8 -->
  <section id="age">
    <h2>8. Âge minimum</h2>
    <p>
      Canari est réservé aux membres de la communauté de l'École des Mines de Saint-Étienne. L'accès
      est conditionné à la possession d'un compte institutionnel EMSE valide.
      <strong>L'application n'est pas destinée aux enfants de moins de 13 ans</strong> (ou l'âge
      minimum requis par la loi applicable dans votre pays, si plus élevé). Nous ne collectons pas
      sciemment de données personnelles auprès de mineurs de moins de 13 ans. Si vous êtes parent ou
      tuteur et pensez que votre enfant nous a fourni des données, contactez-nous à
      <a href="mailto:bureau@rootz-emse.fr">bureau@rootz-emse.fr</a>
      pour demander leur suppression immédiate.
    </p>
  </section>

  <!-- 9 -->
  <section id="droits">
    <h2>9. Vos droits (RGPD)</h2>
    <p>Conformément au RGPD (Règlement UE 2016/679), vous disposez des droits suivants :</p>
    <dl class="legal-terms">
      {#each [['Accès', "Obtenir une copie de l'ensemble des données vous concernant traitées par Canari."], ['Rectification', "Corriger des informations inexactes. Le nom, prénom et e-mail provenant de l'EMSE doivent être corrigés via votre compte institutionnel."], ['Suppression', 'Demander la suppression de votre compte et de toutes les données associées. Voir ci-dessous.'], ['Limitation', 'Demander la suspension temporaire du traitement de vos données.'], ['Portabilité', 'Recevoir vos données dans un format structuré, lisible par machine (JSON).'], ['Opposition', 'Vous opposer à certains traitements, dans la mesure compatible avec la nature du service.']] as [droit, desc], i (i)}
        <div>
          <dt>{droit}</dt>
          <dd>{desc}</dd>
        </div>
      {/each}
    </dl>

    <div class="legal-note">
      <p class="legal-callout-title">Suppression de compte et de données</p>
      <p>
        Pour demander la suppression de votre compte et de toutes les données associées, envoyez un
        e-mail à <a href="mailto:bureau@rootz-emse.fr">bureau@rootz-emse.fr</a>
        avec l'objet <em>" Suppression compte Canari "</em> depuis l'adresse e-mail liée à votre compte
        EMSE. Nous traiterons votre demande dans un délai de 30 jours.
      </p>
      <p class="legal-fineprint">
        Certaines données peuvent être conservées au-delà de ce délai si la loi l'exige (ex. données
        de transaction à des fins fiscales/comptables, logs de sécurité en cas d'incident en cours).
      </p>
    </div>

    <div class="legal-block">
      <p class="legal-block-title">Notification de violation de données</p>
      <p>
        En cas de violation de données susceptible d'engendrer un risque pour vos droits et
        libertés, l'association Rootz notifiera la CNIL dans les 72 heures conformément à l'article
        33 du RGPD. Si cette violation est susceptible d'engendrer un risque élevé, vous serez
        également notifié directement (article 34 du RGPD) dans les meilleurs délais.
      </p>
    </div>

    <p>
      Pour exercer vos droits, contactez-nous à
      <a href="mailto:bureau@rootz-emse.fr">bureau@rootz-emse.fr</a>. Vous disposez également du
      droit d'introduire une réclamation auprès de la
      <strong>CNIL</strong> (<a href="https://www.cnil.fr" target="_blank" rel="noopener"
        >www.cnil.fr</a
      >).
    </p>
  </section>

  <!-- 10 -->
  <section id="modifications">
    <h2>10. Modifications de la politique</h2>
    <p>
      L'association Rootz se réserve le droit de modifier la présente politique à tout moment,
      notamment pour se conformer à de nouvelles obligations légales ou à l'évolution du service. En
      cas de modification substantielle, vous serez notifié par une notification dans l'application
      au moins 15 jours avant l'entrée en vigueur des changements. La date de " Dernière mise à jour
      " en haut de cette page reflète la version en vigueur. La poursuite de l'utilisation de Canari
      après cette date vaut acceptation des nouvelles conditions.
    </p>
  </section>

  <!-- 11 -->
  <section id="contact">
    <h2>11. Contact</h2>
    <div class="legal-block">
      <p><strong>Association Rootz</strong></p>
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
