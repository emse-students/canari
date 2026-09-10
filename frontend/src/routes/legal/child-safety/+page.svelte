<script lang="ts">
  import LegalDocument from '$lib/components/legal/LegalDocument.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * The document's own sections, in order. Numbered here because the DOCUMENT numbers
   * them - the rail renders the label verbatim and never counts.
   */
  const sections = [
    { id: 'contexte', label: 'Contexte et audience' },
    { id: 'mesures', label: 'Mesures de protection' },
    { id: 'signalement', label: "Signalement d'abus" },
    { id: 'consequences', label: 'Conséquences des violations' },
  ];
</script>

<svelte:head>
  <title>{m.legal_child_safety_title()} - Canari</title>
</svelte:head>

<LegalDocument
  title={m.legal_child_safety_title()}
  subtitle={m.legal_child_safety_subtitle()}
  updated="21/05/2026"
  {sections}
>
  <!-- Engagement principal -->
  <section id="engagement">
    <div class="legal-alert">
      <p class="legal-callout-title">Interdiction absolue</p>
      <p>
        L'application <strong>Canari</strong>, éditée par l'association <strong>Rootz</strong>,
        interdit strictement et sans exception toute forme d'abus et d'exploitation sexuels
        d'enfants (CSAE - Child Sexual Abuse and Exploitation), y compris :
      </p>
      <ul>
        <li>
          La production, le partage, la distribution ou la possession de matériel d'abus sexuel sur
          mineurs (CSAM)
        </li>
        <li>Tout contenu à caractère sexuel impliquant des personnes mineures</li>
        <li>La sollicitation sexuelle de mineurs (<em>grooming</em>)</li>
        <li>Tout comportement facilitant ou promouvant l'exploitation sexuelle d'enfants</li>
      </ul>
    </div>
  </section>

  <!-- Contexte -->
  <section id="contexte">
    <h2>Contexte et audience</h2>
    <p>
      Canari est une application de messagerie sécurisée réservée exclusivement aux membres de la
      communauté de l'École des Mines de Saint-Étienne (EMSE). L'accès est contrôlé par le portail
      d'authentification unique de l'École des Mines (OIDC), ce qui limite l'accès aux étudiants,
      enseignants et personnels de l'établissement.
    </p>
    <p>
      L'application n'est pas destinée aux mineurs. L'accès est conditionné à l'appartenance à la
      communauté EMSE, dont les membres sont majoritairement des adultes. Tout accès non autorisé
      est prohibé par les
      <a href="/legal/cgu">{m.legal_cgu_link()}</a>.
    </p>
  </section>

  <!-- Mesures techniques -->
  <section id="mesures">
    <h2>Mesures de protection</h2>
    <dl class="legal-terms">
      {#each [["Contrôle d'accès", "L'accès à Canari est limité aux comptes authentifiés via le portail OIDC de l'EMSE. Aucun compte public ou anonyme n'est possible."], ['Chiffrement de bout en bout', 'Toutes les communications privées sont chiffrées via le protocole MLS (RFC 9420). Le serveur ne peut pas lire le contenu des messages.'], ['Modération', "L'association Rootz se réserve le droit de suspendre immédiatement tout compte et de supprimer tout contenu enfreignant ces normes."], ['Signalement aux autorités', 'Tout contenu CSAE détecté ou signalé sera immédiatement transmis aux autorités compétentes, conformément à la loi française.']] as [titre, desc], i (i)}
        <div>
          <dt>{titre}</dt>
          <dd>{desc}</dd>
        </div>
      {/each}
    </dl>
  </section>

  <!-- Signalement -->
  <section id="signalement">
    <h2>Signalement d'abus</h2>
    <p>
      Si vous observez ou suspectez la présence de contenu CSAE sur Canari, vous êtes fortement
      encouragé(e) à le signaler immédiatement :
    </p>
    <div class="legal-block">
      <p>
        <strong>Email :</strong>
        <a href="mailto:bureau@rootz-emse.fr">bureau@rootz-emse.fr</a>
      </p>
      <p class="legal-fineprint">
        Objet recommandé : <em>" Signalement CSAE - Canari "</em>. Décrivez la situation, incluez
        toute information pertinente (date, contenu, utilisateur concerné si connu). Nous traiterons
        le signalement dans les meilleurs délais.
      </p>
    </div>
    <p>
      Vous pouvez également signaler directement aux autorités françaises via le portail
      <a href="https://www.internet-signalement.gouv.fr" target="_blank" rel="noopener"
        >internet-signalement.gouv.fr</a
      >
      ou contacter le <strong>3018</strong> (numéro national de prévention du cyberharcèlement).
    </p>
  </section>

  <!-- Conséquences -->
  <section id="consequences">
    <h2>Conséquences des violations</h2>
    <p>
      Tout utilisateur dont le compte est associé à du contenu CSAE ou à une exploitation sexuelle
      d'enfants verra son compte suspendu immédiatement et définitivement. Les faits seront signalés
      aux autorités judiciaires compétentes (Police Nationale, Parquet). L'association Rootz
      coopérera pleinement avec toute enquête officielle.
    </p>
  </section>
</LegalDocument>
