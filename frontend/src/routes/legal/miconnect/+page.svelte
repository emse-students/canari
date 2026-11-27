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

  /**
   * THE VERSION A PERSON ACCEPTS (YYYY-MM-DD), distinct from `updated`, the date of the text's last
   * revision (owner, 2026-11-27): a MATERIAL change moves this, and with it the version literal of
   * 45-consent.yaml, so every account is asked once more; a MINOR revision moves `updated` alone and
   * asks nobody. check-consent-version.sh pins this value to the other four places.
   */
  const acceptedVersion = '2026-11-24';
  const acceptedVersionLabel = acceptedVersion.split('-').reverse().join('/');
</script>

<!-- The text the MiConnect consent stage links to (infrastructure/authentik/blueprints/45-consent.yaml), and
     the ONE detailed copy: the stage's notice is two sentences and this link.
     A MINOR revision (a service retired, a wording made precise, a recipient added under rules already
     described) => `updated` only. A MATERIAL change (a new kind of data, a new purpose) => `updated` AND
     `acceptedVersion` above AND the version literal in that blueprint, so everyone is asked again. -->
<LegalDocument
  title={m.legal_miconnect_title()}
  subtitle={m.legal_miconnect_subtitle()}
  updated="27/11/2026"
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
        si ton compte a été créé par le CAS : ton <strong>adresse e-mail de l'École</strong>,
        transmise par le CAS à ta première connexion ;
      </li>
      <li>
        ce que tu déclares à ta première connexion : ton campus, ta ou tes formations, ton année
        d'entrée et tes appartenances (élève, personnel de l'École, de la Maison des Élèves ou des
        Alumni) ;
      </li>
      <li>la version de ces conditions que tu as acceptée, et la date ;</li>
      <li>
        si ton compte est lié à ton compte <strong>Alumni</strong>, et, à chaque connexion avec ce
        compte, si tu es <strong>cotisant</strong> de l'association des Alumni, avec la date de cette
        lecture ;
      </li>
      <li>
        si ton compte MiConnect a été créé par les Alumni : ton <strong>adresse e-mail</strong>
        enregistrée chez les Alumni, et un identifiant de la forme <code>alumni-</code> suivi de ton numéro
        d'ancien ;
      </li>
      <li>
        des journaux techniques de connexion (adresse IP, date, service demandé), conservés pour la
        sécurité pendant une durée limitée (90 jours visés).
      </li>
    </ul>
    <p>
      MiConnect ne reçoit ni ne stocke jamais ton mot de passe : il reste chez le CAS ou les Alumni.
      Les services reçoivent une adresse e-mail technique, pas ton adresse personnelle, à une
      exception près : si ton compte a été créé par le CAS et que son adresse e-mail est en
      <code>etu.emse.fr</code> (élèves) ou en <code>emse.fr</code> (personnel), Canari la reçoit, pour
      te proposer la messagerie de l'École ; son serveur n'en garde que la catégorie, élève ou personnel.
      Aucun service ne reçoit l'adresse enregistrée chez les Alumni.
    </p>
    <p>
      Ta qualité de cotisant et ton adresse e-mail des Alumni ne sont transmises à aucun service, à
      une exception près : si ton compte a été créé par les Alumni, les administrateurs de Canari
      peuvent le rattacher à ton compte existant. Pour en décider, ils voient l'adresse e-mail et la
      dernière connexion à MiConnect des deux comptes quand ton nom et ta promo n'en désignent
      qu'un, ou, s'ils le rattachent à la main, de chaque compte qu'une recherche par nom leur
      propose ; ces informations sont lues chez MiConnect sans être conservées. Le rattachement ne
      se fait qu'à ta connexion Alumni suivante, et seulement si le compte existant est lié au CAS
      et que les noms vus par l'administrateur sont toujours ceux des deux comptes ; chaque
      rattachement, ou son refus, est journalisé avec l'adresse IP de la connexion. Sky, MiGallery
      et Le Cercle reçoivent alors, dans un jeton signé, les identifiants techniques des deux
      comptes, pour y rattacher ou effacer le compte en double. MiConnect se sert de ta qualité de
      cotisant : après tes cinq premières années à l'École (jusqu'au 31 août de ton année d'entrée
      plus cinq), MiGallery, Le Cercle et le wiki Mino sont réservés aux cotisants de l'année en
      cours, aux personnels et aux personnes que les administrateurs y autorisent. Canari reçoit le
      fait que ton compte Alumni est lié, pour te rappeler de le lier ; et quand tu ouvres MiGallery
      ou Le Cercle depuis Canari, son serveur lit cette même règle chez MiConnect, sans la
      conserver, pour ne t'y ouvrir déjà connecté que si MiConnect t'y laisserait entrer.
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
      MiConnect : Canari, Sky, MiGallery, Le Cercle et le wiki Mino. Chacun ne s'en sert que pour te
      reconnaître et afficher ton profil, et publie ses propres conditions pour le reste de ce qu'il
      fait.
    </p>
    <p>
      La console de supervision du réseau de la Maison des Élèves, outil de l'association Rootz, ne
      reçoit que les personnes que ses administrateurs y autorisent, et d'elles seulement leur nom
      complet, leur identifiant, un identifiant technique et le nom de son groupe d'accès (<code
        >acces-reseau</code
      >), rien de leur profil.
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
      redemandée quand elles changent de façon importante, une seule fois par version, pour tous les
      services à la fois. Tu peux demander la suppression de ton compte MiConnect à tout moment en
      écrivant au contact ci-dessus ; tu ne pourras plus te connecter aux services tant que tu
      n'auras pas un nouveau compte.
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
      Si ces conditions changent de façon importante (une donnée ou un usage nouveau), la case t'est
      redemandée à la connexion suivante. Une modification mineure (un service retiré, une
      formulation précisée, un service ajouté qui ne reçoit les données que des personnes qui s'y
      connectent elles-mêmes) change seulement la date en haut de cette page, sans rien te
      redemander. Version en vigueur pour l'acceptation : {acceptedVersionLabel}.
    </p>
  </section>
</LegalDocument>
