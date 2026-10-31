# Guide responsable d'association

> Pour les administrateurs, moderateurs et membres du bureau des associations EMSE.

---

## Roles et permissions

Un membre d'association n'a pas de role predefini : il a une **liste de droits coches un par un**.
Le libelle affiche a cote de son nom ("Presidente", "Tresorier") est decoratif et ne donne aucun
droit. Chacun des onze droits ouvre une partie precise de l'interface.

**Tout est detaille dans une page dediee : [Les permissions d'une association](permissions-association.md).**
Elle liste les onze droits, ce que chacun permet, comment les cocher, et les deux niveaux
(administrateur de la plateforme, BDE) qui agissent sans etre membres.

Les exemples ci-dessous nomment, a chaque fois, le droit necessaire.

---

## 1. Acceder a l'interface de gestion

1. Rendez-vous sur la fiche de votre association (`/associations/[votre-association]`).
2. Si vous avez le role Administrateur, un bouton **"Gerer"** est visible.
3. Vous pouvez aussi acceder directement depuis le **Dashboard** (`/dashboard`).

Le bouton **"Gerer"** apparait des que vous avez au moins un droit de gestion. L'interface
comprend jusqu'a dix sections - **Profil**, **Membres**, **Documents**, **Achats**,
**Cotisations**, **Delegation**, **Formulaires**, **Partenariats**, **Paiements**, **Danger** -
et chacune n'est visible que si vous avez le droit correspondant
([tableau complet](permissions-association.md#4-ce-que-les-onglets-de-gestion-demandent)).

---

## 2. Profil de l'association

Dans l'onglet **Profil** :

- Modifier le **nom** et la **description** (Markdown supporte).
- Changer le **logo** (image carre recommandee).
- Choisir la **couleur** principale de l'association (affichee dans l'annuaire).

Cliquez sur **"Enregistrer"** pour appliquer les modifications.

---

## 3. Gestion des membres

Dans l'onglet **Membres** :

### Ajouter un membre

> Toute cette section demande le droit *Gerer les membres*.

1. Cherchez l'utilisateur par nom ou identifiant dans le champ de recherche.
2. Choisissez **"Membre"** (aucun droit) ou **"Administrateur"** (tous les droits de gestion de
   l'association, y compris la gestion du compte bancaire).
3. Cliquez sur **"Ajouter"**.

### Modifier les droits d'un membre

Le champ texte a cote du membre change son libelle de role, sans toucher a ses droits. Pour les
droits eux-memes, cliquez sur le bouton affichant leur nombre : chaque case cochee ou decochee est
enregistree immediatement. Voir [Les permissions d'une association](permissions-association.md).

### Retirer un membre

Cliquez sur l'icone de suppression a cote du membre.

> Vous ne pouvez pas retirer le droit *Gerer les membres* au dernier membre qui le possede :
> l'association se retrouverait sans personne pour gerer ses membres.

---

## 4. Publications (posts)

Pour publier une actualite **au nom de l'association** :

1. Depuis la page **Posts**, cliquez sur **"Nouvelle publication"**.
2. Dans le champ "Publier en tant que", selectionnez votre association
   (visible uniquement si vous avez le droit *Publier au nom de l'asso*).
3. Redigez votre contenu (Markdown supporte).

Options disponibles :
- **Image** : joindre une image a la publication.
- **Sondage** : ajouter une question avec options de vote.
- **Formulaire integre** : lier un formulaire de l'association.
- **Planification** : programmer la publication a une date et heure futures.

### Epingler une publication

Depuis la liste des publications, cliquez sur "..." -> **"Epingler"** pour mettre la
publication en tete de fil. Action reservee aux membres ayant le droit
*Publier au nom de l'asso*.

---

## 5. Evenements et calendrier

Depuis la fiche de votre association (section Calendrier) ou depuis `/events/new` :

### Creer un evenement

1. Cliquez sur **"Nouvel evenement"**.
2. Renseignez : titre, description, date/heure de debut et de fin, lieu.
3. En option : limite de participants, lien vers un formulaire d'inscription.
4. Cliquez sur **"Creer"**.

L'evenement apparait dans le calendrier de l'association et dans le calendrier global du campus.

### Modifier ou supprimer un evenement

Cliquez sur l'evenement puis sur **"Modifier"** ou **"Supprimer"**.

---

## 6. Formulaires

### Creer un formulaire

Dans l'onglet **Formulaires** :

1. Cliquez sur **"Nouveau formulaire"**.
2. Renseignez :
   - **Titre** et **description**.
   - **Champs** : texte court, texte long, choix unique, choix multiple, nombre, date.
   - **Periode d'ouverture** : date/heure de debut et de fin.
   - **Limite de reponses** (optionnel).
   - **Prix** : 0 pour un formulaire gratuit, ou un montant en euros.
   - **Paiement en especes autorise** : si oui, les soumissions "especes" seront en attente
     de validation manuelle.
3. Cliquez sur **"Creer"**.

### Gerer les soumissions

- Cliquez sur un formulaire pour voir la liste des soumissions.
- Pour les **paiements en especes en attente** :
  - Cliquez sur **"Valider"** une fois le paiement recu, ou **"Refuser"** si le membre
    ne s'est pas presente.
- Exportez les reponses en **fichier Excel** (.xlsx) via le bouton **"Exporter"**.

### Formulaire public (personnes sans compte)

Un formulaire peut etre rempli, et paye, par des personnes sans compte Canari depuis un
simple lien : voir [Formulaires publics](formulaires-publics.md).

### Rappels automatiques

Le systeme envoie automatiquement une notification push aux utilisateurs qui ont "suivi" le
formulaire, 5 minutes avant son ouverture. Aucune configuration requise.

---

## 7. Documents

Depuis la fiche de votre association (section Documents) :

- **Ajouter** : cliquez sur "+" et selectionnez un fichier (PDF, images...).
- **Telechargement** : les membres peuvent telecharger les documents publics.
- **Supprimer** : cliquez sur la corbeille a cote du document.

---

## 8. Boutique et paiements en ligne (Lydia)

Lorsque les paiements en ligne sont **actives** sur la plateforme, ils passent par **Lydia** (la page de paiement s'appelle
"Paiement Canari" cote acheteur). Chaque association relie **son propre compte Lydia Pro** : l'argent
arrive sur ce compte, jamais sur celui de Canari.

### Relier le compte Lydia de l'association

Dans l'onglet **Paiements** (droit *Gerer le compte bancaire*) :

1. Dans la carte **Lydia Pro**, renseignez les informations legales de l'association : nom legal,
   adresse, code postal, ville, pays, email et telephone de contact. Elles sont transmises
   directement a Lydia.
2. Cliquez sur **"Creer le compte Lydia Pro"**. Le compte est cree chez Lydia et passe en
   **"En attente"**.
3. Lydia valide ensuite le dossier de l'association. Canari ne suit pas encore cette validation
   automatiquement : un administrateur de la plateforme confirme l'activation (bouton
   **"Valider l'onboarding"**, qu'il est le seul a voir). Le statut passe alors a **"Actif"**.
4. Renseignez la **cle privee Business** dans le champ prevu a cet effet. Vous la trouvez dans votre
   espace Lydia Business, rubrique "Mes informations". Elle est chiffree sur le serveur et ne
   s'affiche plus jamais, meme pour vous (utilisez **"Remplacer la cle privee"** pour la changer).
   Canari ne controle pas la cle a l'enregistrement : une cle erronee ne se voit qu'a la premiere
   confirmation refusee.

Cette cle permet a Canari de verifier les notifications envoyees par Lydia. Sans elle, ces
notifications ne peuvent pas etre verifiees : le paiement est alors suivi surtout lorsque la
personne qui paie revient dans l'application. Canari ne promet pas de confirmation automatique de
chaque paiement : en cas de doute sur un paiement, verifiez son statut dans l'onglet **Achats**
et dans le tableau de bord Lydia.

Le bouton **"Ouvrir le tableau de bord Lydia"** ouvre l'espace Lydia de l'association ;
**"Retirer Lydia"** detache le compte de Canari (le compte Lydia lui-meme n'est pas supprime, mais il
faudra refaire toute la configuration pour accepter a nouveau des paiements en ligne).

> Tant que le compte Lydia n'est pas **Actif**, seul le paiement en especes est disponible pour les
> formulaires payants, et les produits de la boutique restent inactifs. Ils se remettent en vente
> d'eux-memes des que les paiements sont prets. Si l'onglet indique qu'aucun prestataire de paiement
> n'est configure, les paiements en ligne sont coupes sur toute la plateforme : ce n'est pas un
> reglage de votre association.

### Les caissiers Lydia Pro

Une fois le compte Lydia relie et son **Responsable** confirme, la section **"Caissiers"** de l'onglet
paiements liste les membres qui utilisent l'application **Lydia Pro** pour l'association : nom, role,
deux derniers chiffres du numero, date d'ajout et qui les a ajoutes. Seuls les membres qui gerent le
compte de versement de l'association la voient.

- **Responsable** : tous les droits, dont l'ajout et le retrait des caissiers. Il n'est pas retire
  depuis cette liste : l'association n'aurait plus personne pour gerer son compte Lydia.
- **Tresorier** : consulter les releves, rembourser et annuler des paiements.
- **Vendeur** : encaisser.

Chaque personne ajoutee recoit un SMS de Lydia et une notification Canari qui mene a la page
**"Qu'est-ce que Lydia Pro ?"** (installer l'application et s'y connecter avec ce numero).

**Retirer** un caissier lui enleve tous ses droits chez Lydia, apres confirmation. Canari verifie
aupres de Lydia que le retrait a bien eu lieu : sinon la ligne reste affichee avec **"Retrait non
confirme chez Lydia, reessayez"**, et il suffit de recommencer.

**Changer le numero du Responsable** : dans l'etape Responsable, **"Renvoyer le SMS ou changer de
numero"**, puis saisissez le nouveau numero. Le nouveau numero est ajoute chez Lydia, puis l'ancien
est retire. Si ce retrait n'est pas confirme, l'ancien numero reste affiche dans la liste des caissiers
avec le bouton **"Retirer l'ancien numero"** ; un nouveau changement de numero n'est possible qu'une
fois l'ancien retire.

> L'ajout d'un tresorier ou d'un vendeur, et le changement de role, ne sont pas encore ouverts : ils le
> seront une fois qu'un premier retrait aura ete verifie en production.

### Creer un produit

Depuis la carte **Boutique** de l'onglet **Paiements** (droit *Gerer la boutique et les cotisations*) :

1. Cliquez sur **"Nouveau produit"**.
2. Renseignez le nom, la description, puis le prix : un **prix fixe**, ou un **montant libre**
   (avec un minimum et un maximum). Vous pouvez aussi fixer un **tarif cotisant**, reserver le
   produit aux cotisants, ou definir une **grille tarifaire** (prix different selon la promotion,
   la formation ou la cotisation).
3. Reglez si besoin les **limites d'achat** : achats multiples, maximum par utilisateur, stock
   global.
4. Cliquez sur **"Creer le produit"**.

Le produit apparait dans la boutique globale et sur la fiche de votre association. Chaque tentative
d'achat est enregistree separement : un paiement refuse ou abandonne peut etre retente.

### Suivre les ventes

L'onglet **Achats** liste l'historique des paiements de la boutique et des formulaires payants
(date, acheteur, article, type, mode de paiement **"En ligne"** ou **"Especes / manuel"**, montant).
Il permet aussi d'attribuer un produit a la main (especes, paiement anterieur a Canari).
Pour le detail cote Lydia, utilisez **"Ouvrir le tableau de bord Lydia"** dans l'onglet
**Paiements**.

---

## 9. Channels et communaute

### Creer un channel

Depuis le workspace de votre association dans la messagerie :

1. Cliquez sur **"+"** a cote de "Channels".
2. Donnez un nom et choisissez la visibilite (public / prive).
3. Pour un channel prive, selectionnez les membres qui y ont acces.

### Gerer les membres d'un channel

Cliquez sur le nom du channel -> **"Parametres"** -> **"Membres"** pour ajouter ou retirer
des participants.

---

## 10. Bonnes pratiques

- **Nommez les channels clairement** : "general", "evenements-2025", "logistique-gala", etc.
- **Archivez les channels inactifs** plutot que de les supprimer (les messages sont conserves).
- **Verifiez vos soumissions de formulaires** regulierement, surtout les paiements en especes.
- **Mettez a jour le profil** de l'association chaque annee (logo, description, contacts).
