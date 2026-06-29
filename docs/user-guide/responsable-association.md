# Guide responsable d'association

> Pour les administrateurs, moderateurs et membres du bureau des associations EMSE.

---

## Roles et permissions

Chaque membre d'une association a un role :

| Role | Permissions |
|---|---|
| **Membre** | Acceder aux channels, participer aux evenements, soumettre des formulaires |
| **Moderateur** | Tout ce que le Membre peut faire + moderer les messages dans les channels |
| **Administrateur** | Acces complet : gerer les membres, les roles, la boutique, les formulaires, les evenements, le profil de l'association |

Seuls les **Administrateurs** peuvent modifier la configuration de l'association.

---

## 1. Acceder a l'interface de gestion

1. Rendez-vous sur la fiche de votre association (`/associations/[votre-association]`).
2. Si vous avez le role Administrateur, un bouton **"Gerer"** est visible.
3. Vous pouvez aussi acceder directement depuis le **Dashboard** (`/dashboard`).

L'interface de gestion comprend quatre onglets : **Profil**, **Membres**, **Formulaires**, **Paiements**.

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

1. Cherchez l'utilisateur par nom ou identifiant dans le champ de recherche.
2. Selectionnez son role (Membre, Moderateur, Administrateur).
3. Cliquez sur **"Ajouter"**.

### Modifier le role d'un membre

Cliquez sur le role affiche a cote du membre pour le modifier via la liste deroulante.

### Retirer un membre

Cliquez sur l'icone de suppression a cote du membre.

> Un administrateur ne peut pas se retirer lui-meme si c'est le dernier admin de l'association.

---

## 4. Publications (posts)

Pour publier une actualite **au nom de l'association** :

1. Depuis la page **Posts**, cliquez sur **"Nouvelle publication"**.
2. Dans le champ "Publier en tant que", selectionnez votre association
   (visible uniquement si vous avez le droit `MANAGE_ASSO`).
3. Redigez votre contenu (Markdown supporte).

Options disponibles :
- **Image** : joindre une image a la publication.
- **Sondage** : ajouter une question avec options de vote.
- **Formulaire integre** : lier un formulaire de l'association.
- **Planification** : programmer la publication a une date et heure futures.

### Epingler une publication

Depuis la liste des publications, cliquez sur "..." -> **"Epingler"** pour mettre la
publication en tete de fil. Action reservee aux administrateurs.

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

## 8. Boutique et paiements Stripe

### Configurer Stripe Connect

Pour accepter des paiements en ligne, votre association doit completer l'onboarding Stripe :

1. Dans l'onglet **Paiements**, cliquez sur **"Configurer les paiements en ligne"**.
2. Vous etes redirige vers Stripe pour creer ou lier un compte de votre association.
3. Renseignez les informations bancaires de l'association (IBAN, SIRET le cas echeant).
4. Une fois configure, le statut affiche **"Actif"**.

> Tant que Stripe Connect n'est pas configure, seul le paiement en especes est disponible
> pour les formulaires payants. Les produits de la boutique necessitent Stripe Connect.

### Creer un produit

Depuis l'onglet Boutique de votre association :

1. Cliquez sur **"Nouveau produit"**.
2. Renseignez : nom, description, prix, photo (optionnel), stock (optionnel).
3. Cliquez sur **"Creer"**.

Le produit apparait dans la boutique globale et sur la fiche de votre association.

### Suivre les ventes

Depuis l'onglet **Paiements**, cliquez sur **"Tableau de bord Stripe"** pour acceder au
dashboard Stripe de votre association (historique des paiements, virements, litiges).

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
