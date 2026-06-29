# Guide membre

> Pour les etudiants et le personnel EMSE utilisant Canari au quotidien.

---

## 1. Connexion et premier lancement

### Compte ICM (etudiants et personnel EMSE)

1. Sur la page de connexion, cliquez sur **"Se connecter avec mon compte EMSE"**.
2. Vous etes redirige vers la page Authentik de l'EMSE. Entrez vos identifiants EMSE habituels.
3. A votre tout premier lancement, Canari vous demande de choisir un **code PIN**.

### Compte non-ICM (externes, invites)

Votre compte est cree par un administrateur de la plateforme. Vous recevez un lien d'invitation
par email. Suivez le lien pour definir votre mot de passe, puis connectez-vous via le bouton
**"Se connecter"** de la page de connexion.

### Le code PIN

Le PIN protege vos messages localement sur votre appareil. Il est utilise pour chiffrer votre
historique de messages stocke sur l'appareil — il n'est jamais transmis au serveur.

> **Important** : si vous perdez votre PIN et votre session expire, vous ne pourrez plus lire
> vos anciens messages sur cet appareil. Vos futurs messages resteront accessibles apres
> reconnexion. Choisissez un PIN que vous ne risquez pas d'oublier.

---

## 2. Messagerie

### Demarrer une conversation

1. Depuis la page **Chat**, cliquez sur l'icone "+" (ou "Nouvelle conversation").
2. Recherchez un utilisateur par nom ou identifiant.
3. La conversation s'ouvre. Ecrivez votre message et appuyez sur Envoi.

Les messages sont **chiffres de bout en bout** : seuls vous et votre interlocuteur pouvez les lire.
Le serveur ne voit que des donnees chiffrees.

### Creer un groupe

1. Cliquez sur "+" -> **"Nouveau groupe"**.
2. Donnez un nom au groupe et ajoutez des participants.
3. Les messages du groupe sont egalement chiffres de bout en bout.

### Fonctionnalites de base

| Action | Comment faire |
|---|---|
| Envoyer un fichier ou une image | Cliquez sur le trombone dans le compositeur |
| Reagir a un message | Appui long sur le message (mobile) ou survolez (desktop) -> emoji |
| Repondre a un message | Appui long -> "Repondre" (ou fleche de reponse) |
| Modifier un message envoye | Appui long -> "Modifier" |
| Supprimer un message | Appui long -> "Supprimer" (le message disparait pour tous) |
| Rechercher dans une conversation | Icone loupe dans l'en-tete de la conversation |

### Multi-appareils

Quand vous vous connectez sur un nouvel appareil, vous recevez les **messages futurs** mais
pas l'historique anterieur — c'est une propriete de securite du protocole (forward secrecy).
Chaque appareil est enregistre independamment.

---

## 3. Communautes (workspaces et channels)

Les associations disposent chacune d'un **workspace**. A l'interieur, des **channels**
permettent d'echanger par thematique (general, evenements, projets...).

### Rejoindre une communaute

Vous pouvez etre ajoute a une communaute par un responsable de l'association, ou y acceder
via un lien d'invitation.

### Naviguer dans les channels

- La barre laterale gauche liste vos workspaces et leurs channels.
- Cliquez sur un channel pour l'ouvrir.
- Les channels publics sont visibles par tous les membres du workspace.
  Les channels prives requierent une invitation du responsable.

---

## 4. Fil d'actualites

### Consulter les publications

La page **Posts** affiche les actualites de toutes les associations. Trois onglets sont
disponibles :

| Onglet | Contenu |
|---|---|
| Tout | Toutes les publications |
| Suivis | Publications des associations que vous suivez |
| Par association/categorie | Filtrer par association ou categorie |

Faites defiler pour charger plus de publications (chargement automatique).

### Interagir avec une publication

- **Reaction** : cliquez sur un emoji pour reagir.
- **Commentaire** : cliquez sur "Commenter" et ecrivez votre reponse.
- **Signalement** : cliquez sur "..." -> "Signaler" si le contenu est inapproprie.

---

## 5. Associations et annuaire

### Trouver une association

Depuis la page **Associations**, parcourez l'annuaire ou utilisez la barre de recherche.
Cliquez sur une association pour voir sa fiche : description, membres, evenements, documents.

### Suivre une association

Sur la fiche d'une association, cliquez sur **"Suivre"**. Ses publications apparaitront dans
votre onglet "Suivis" du fil d'actualites.

---

## 6. Formulaires

Les associations proposent des formulaires en ligne pour les inscriptions, adhesions, etc.

1. Cliquez sur le lien du formulaire (depuis un post ou depuis la fiche de l'association).
2. Remplissez les champs.
3. Si le formulaire necessite un paiement :
   - **Paiement en ligne** : vous serez redirige vers Stripe Checkout (carte bancaire securisee).
   - **Paiement en especes** : votre inscription est enregistree en attente. Un responsable
     la validera apres avoir recu votre paiement.

---

## 7. Calendrier

La page **Calendrier** affiche les evenements a venir de toutes les associations.

- Filtrez par association pour n'afficher que ses evenements.
- Cliquez sur un evenement pour voir les details.
- Cliquez sur **"Exporter"** pour telecharger un fichier `.ics` compatible avec
  Google Calendar, Apple Calendar, Outlook, etc.

---

## 8. Notifications

- Sur **mobile**, vous recevez des notifications push pour les nouveaux messages,
  reactions, mentions et evenements.
- Sur **desktop** (application Tauri), les notifications systeme sont disponibles.
- Pour gerer vos preferences de notification, rendez-vous dans votre **Profil**.

---

## 9. Profil et parametres

Depuis votre avatar (en haut a droite ou dans le menu) :

- Modifier votre photo de profil et votre nom d'affichage.
- Changer votre PIN.
- Se deconnecter.

---

## Questions frequentes

**Je ne vois pas mes anciens messages apres reinstallation.**
C'est normal. L'historique est chiffre localement avec votre PIN. Si vous avez reinstalle
l'app ou change d'appareil, vous recevrez les messages futurs mais pas l'historique passe.

**J'ai oublie mon PIN.**
Reconnectez-vous normalement. Si votre session est encore active, vous pouvez redefinir
votre PIN dans les parametres. Sinon, une reinstallation cree un nouveau profil de chiffrement
(les anciens messages restes chiffres localement ne seront plus accessibles).

**Je ne recois pas les notifications.**
Verifiez que les notifications sont autorisees pour Canari dans les parametres de votre
appareil (Parametres -> Applications -> Canari -> Notifications).
