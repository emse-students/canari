<script lang="ts">
  import LegalDocument from '$lib/components/legal/LegalDocument.svelte';
  import { m } from '$lib/paraglide/messages';

  /** Numbered here because the DOCUMENT numbers its sections - the rail renders the label verbatim. */
  const sections = [
    { id: 'objet', label: '1. Objet' },
    { id: 'donnees', label: '2. Données enregistrées' },
    { id: 'services', label: '3. Services concernés' },
    { id: 'consentement', label: '4. Ton consentement' },
    { id: 'droits', label: '5. Tes droits' },
    { id: 'modifications', label: '6. Modifications' },
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
    <h2>1. Objet</h2>
    <p>
      <strong>MiConnect</strong> est le service de connexion des associations de l'École des Mines de
      Saint-Étienne. Il te permet d'ouvrir une session avec ton compte du CAS de l'École, ou avec celui
      de l'association des Alumni, et de la réutiliser dans les services listés ci-dessous.
    </p>
    <div class="legal-block">
      <p><strong>Responsable du traitement :</strong> Association Rootz - EMSE</p>
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
      <li>la version des présentes conditions que tu as acceptée, et la date.</li>
    </ul>
    <p>
      MiConnect ne reçoit ni ne stocke jamais ton mot de passe : il reste chez le CAS ou les Alumni.
    </p>
  </section>

  <section id="services">
    <h2>3. Services concernés</h2>
    <p>
      Ces données sont transmises, à chaque connexion, aux services auxquels tu te connectes avec
      MiConnect : Canari, Sky, MiGallery, le portail des associations, Le Cercle et les archives des
      Mines. Chacun ne s'en sert que pour te reconnaître et afficher ton profil ; chacun publie ses
      propres conditions pour le reste de ce qu'il fait.
    </p>
  </section>

  <section id="consentement">
    <h2>4. Ton consentement</h2>
    <p>
      En cochant la case lors de ta connexion, tu acceptes ces conditions et la collecte de ces
      données. Sans cette case, la connexion n'a pas lieu. Tu peux retirer ton consentement à tout
      moment en écrivant au contact ci-dessus : ton compte MiConnect est alors supprimé, et tu ne
      peux plus te connecter aux services tant que tu n'as pas de nouveau accepté.
    </p>
    <p>
      La case est redemandée quand le texte change, et une seule fois par version, pour tous les
      services à la fois.
    </p>
  </section>

  <section id="droits">
    <h2>5. Tes droits</h2>
    <p>
      Conformément au RGPD, tu peux demander l'accès à tes données, leur rectification, leur
      effacement, la limitation du traitement et leur portabilité. Le nom et le prénom venant du CAS
      ou des Alumni se corrigent à la source. Tu peux saisir la CNIL si tu estimes que tes droits ne
      sont pas respectés.
    </p>
  </section>

  <section id="modifications">
    <h2>6. Modifications</h2>
    <p>
      Si ces conditions changent, la date en haut de cette page change et la case t'est redemandée à
      la connexion suivante.
    </p>
  </section>
</LegalDocument>
