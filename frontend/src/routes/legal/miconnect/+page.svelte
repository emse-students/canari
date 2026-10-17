<script lang="ts">
  import LegalDocument from '$lib/components/legal/LegalDocument.svelte';
  import { m } from '$lib/paraglide/messages';

  /** Numbered here because the DOCUMENT numbers its sections - the rail renders the label verbatim. */
  const sections = [
    { id: 'objet', label: '1. Objet et responsable' },
    { id: 'donnees', label: '2. Données enregistrées' },
    { id: 'base', label: '3. Pourquoi, et sur quelle base' },
    { id: 'services', label: '4. Qui les reçoit' },
    { id: 'conservation', label: '5. Durée de conservation' },
    { id: 'acceptation', label: '6. Ton acceptation' },
    { id: 'droits', label: '7. Tes droits' },
    { id: 'modifications', label: '8. Modifications' },
  ];
</script>

<!-- The text the MiConnect consent stage links to (infrastructure/authentik/blueprints/45-consent.yaml).
     CHANGE THE TEXT => bump `updated` here AND the version literal in that blueprint, so everyone is asked again. -->
<LegalDocument
  title={m.legal_miconnect_title()}
  subtitle={m.legal_miconnect_subtitle()}
  updated="16/10/2026"
  {sections}
>
  <section id="objet">
    <h2>1. Objet et responsable</h2>
    <p>
      <strong>MiConnect</strong> est le service de connexion des associations de l'École des Mines de
      Saint-Étienne. Il te permet d'ouvrir une session avec ton compte du CAS de l'École, ou avec celui
      de l'association des Alumni, et de la réutiliser dans les services listés plus bas.
    </p>
    <div class="legal-block">
      <p><strong>Responsable du traitement :</strong> Association Rootz - EMSE</p>
      <p>
        Maison des Élèves de l'École des Mines, 20 Boulevard Alexandre de Fraissinette, 42100
        Saint-Étienne
      </p>
      <p>
        <strong>Contact :</strong>
        <a href="mailto:bureau@rootz-emse.fr">bureau@rootz-emse.fr</a>
      </p>
    </div>
  </section>

  <section id="donnees">
    <h2>2. Données enregistrées</h2>
    <p>Quand tu te connectes, MiConnect enregistre :</p>
    <ul>
      <li>
        ton <strong>nom</strong> et ton <strong>prénom</strong>, transmis par le CAS ou les Alumni ;
      </li>
      <li>ton identifiant de connexion ;</li>
      <li>
        ce que tu déclares à ta première connexion : ton campus, ta ou tes formations, ton année
        d'entrée et tes appartenances (élève, personnel de l'École, de la Maison des Élèves ou des
        Alumni) ;
      </li>
      <li>la version de ces conditions que tu as acceptée, et la date ;</li>
      <li>
        des journaux techniques de connexion (adresse IP, date, service demandé), conservés pour la
        sécurité pendant une durée limitée (90 jours visés).
      </li>
    </ul>
    <p>
      MiConnect ne reçoit ni ne stocke jamais ton mot de passe : il reste chez le CAS ou les Alumni.
      Les services reçoivent une adresse e-mail technique, pas ton adresse personnelle.
    </p>
  </section>

  <section id="base">
    <h2>3. Pourquoi, et sur quelle base</h2>
    <p>
      Ces données servent à te reconnaître et à afficher ton profil dans les services auxquels tu te
      connectes, et à protéger les comptes. La base légale est l'<strong
        >exécution du service</strong
      >
      que tu demandes en te connectant : sans ces données, la connexion est impossible. Ce n'est pas un
      consentement que tu pourrais refuser en gardant l'accès : c'est pourquoi la case ne sert qu'à garder
      la preuve que tu as pris connaissance de ce texte. Ce que les services te proposent en plus (photo,
      annuaire, reconnaissance de visage...) reste soumis à leur propre accord, demandé séparément.
    </p>
  </section>

  <section id="services">
    <h2>4. Qui les reçoit</h2>
    <p>
      Ces données sont transmises, à chaque connexion, aux services auxquels tu te connectes avec
      MiConnect : Canari, Sky, MiGallery, Le Cercle et les archives des Mines. Chacun ne s'en sert
      que pour te reconnaître et afficher ton profil, et publie ses propres conditions pour le reste
      de ce qu'il fait.
    </p>
    <p>
      MiConnect fonctionne sur le serveur partagé de l'École, administré avec sa direction des
      systèmes d'information (DSI), et ses sauvegardes sont copiées sur une seconde machine de
      l'École. Certains anciens noms de domaine passent encore par Cloudflare, qui voit alors les
      requêtes.
    </p>
  </section>

  <section id="conservation">
    <h2>5. Durée de conservation</h2>
    <p>
      Ton compte MiConnect et ses données sont conservés tant que ton compte existe, puis supprimés
      sur ta demande. Les journaux techniques sont conservés pendant une durée limitée (90 jours
      visés). Une suppression peut encore apparaître dans les sauvegardes quelques semaines au plus,
      puis disparaît.
    </p>
  </section>

  <section id="acceptation">
    <h2>6. Ton acceptation</h2>
    <p>
      En cochant la case lors de ta connexion, tu confirmes avoir lu ces conditions. Elle est
      redemandée quand le texte change, une seule fois par version, pour tous les services à la
      fois. Tu peux demander la suppression de ton compte MiConnect à tout moment en écrivant au
      contact ci-dessus ; tu ne pourras plus te connecter aux services tant que tu n'auras pas un
      nouveau compte.
    </p>
  </section>

  <section id="droits">
    <h2>7. Tes droits</h2>
    <p>
      Conformément au RGPD, tu peux demander l'accès à tes données, leur rectification, leur
      effacement, la limitation du traitement, leur portabilité, et t'opposer au traitement. Écris
      au contact ci-dessus : nous répondons sous un mois. Le nom et le prénom venant du CAS ou des
      Alumni se corrigent à la source. Tu peux aussi saisir la CNIL (cnil.fr) si tu estimes que tes
      droits ne sont pas respectés.
    </p>
  </section>

  <section id="modifications">
    <h2>8. Modifications</h2>
    <p>
      Si ces conditions changent, la date en haut de cette page change et la case t'est redemandée à
      la connexion suivante.
    </p>
  </section>
</LegalDocument>
