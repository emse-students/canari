# Les permissions d'une association

> Qui peut faire quoi dans une association, et comment le regler.
> Pour le reste de la gestion, voir le [guide responsable d'association](responsable-association.md).

Dans Canari, un membre d'association n'a pas un "role" avec des droits predefinis. Il a une **liste
de droits que vous cochez un par un**. Le libelle affiche a cote de son nom ("Presidente",
"Tresorier", "Membre") est purement decoratif : il ne donne aucun droit. Seules les cases cochees
comptent.

---

## 1. Les onze droits

| Droit (case a cocher) | Ce qu'il permet |
|---|---|
| **Publier au nom de l'asso** | Publier dans le fil d'actualites sous le nom de l'association au lieu du sien, et modifier ou supprimer les publications faites en son nom |
| **Proposer des evenements** | Deposer un evenement dans l'agenda (il part en validation au BDE), puis le modifier ou le supprimer. Recoit les notifications de validation ou de refus |
| **Gerer les membres** | Ajouter, retirer, renommer et reordonner les membres, **cocher leurs droits**, changer le logo et le profil de l'association, gerer les tags, les cotisants et les paliers de cotisation, exporter la liste |
| **Gerer les documents** | Acceder au coffre de documents prives de l'association, y deposer et y supprimer des fichiers, ecrire les notes internes |
| **Gerer les formulaires** | Creer, modifier et supprimer les formulaires, et lire les reponses recues |
| **Gerer les paiements (boutique)** | La boutique, les achats et leurs exports, la delegation de paiement vers une association parente, les reglages de cotisation |
| **Gerer les partenariats** | Creer et modifier les cartes de partenariat, leurs codes et leurs icones, voir qui a reclame un code |
| **Gerer Stripe Connect** | Lancer ou reprendre la liaison du compte bancaire de l'association. **C'est le droit le plus sensible : il decide ou part l'argent** |
| **Valider les evenements** | *BDE uniquement.* Valider, modifier ou supprimer les evenements de **toutes** les associations, et deposer un evenement deja valide |
| **Gerer les associations** | *BDE uniquement.* Creer une association, et administrer **n'importe quelle** association sans en etre membre (voir section 3) |
| **Moderer** | *BDE uniquement.* Traiter les signalements, supprimer des contenus, rendre un utilisateur muet |

Les trois derniers droits n'ont **aucun effet** en dehors d'une association marquee BDE : les cocher
ailleurs ne fait rien. C'est pourquoi ils n'apparaissent pas dans la liste si votre association n'est
pas le BDE.

---

## 2. Cocher les droits d'un membre

1. Sur la fiche de votre association, cliquez sur **"Gerer"** (visible si vous avez le droit
   *Gerer les membres*).
2. Ouvrez l'onglet **Membres**.
3. Sur la ligne du membre, cliquez sur le bouton qui affiche le nombre de droits.
4. Cochez ou decochez. **Chaque clic est enregistre immediatement** : il n'y a pas de bouton
   "Enregistrer".

Le champ texte a cote sert a changer le libelle du role ("Tresoriere"). Il ne change aucun droit.

Deux garde-fous :

- Vous ne pouvez pas retirer *Gerer les membres* au **dernier** membre qui le possede : l'association
  se retrouverait sans personne pour gerer ses membres. Nommez d'abord son remplacant.
- A l'ajout d'un membre, le bouton **"Administrateur"** coche d'un coup tous les droits non-BDE,
  Stripe Connect inclus. Si ce n'est pas ce que vous voulez, ajoutez la personne en simple membre
  puis cochez ses droits un par un.

---

## 3. Les deux niveaux au-dessus de vous

Deux categories d'utilisateurs peuvent agir sur votre association sans y avoir de droits coches :

**L'administrateur de la plateforme** possede **tous** les droits sur **toutes** les associations,
qu'il en soit membre ou non. C'est le seul a pouvoir supprimer une association, marquer une
association comme BDE ou changer son quota de documents.

**Un membre du BDE ayant le droit *Gerer les associations*** peut administrer n'importe quelle
association : membres, documents, formulaires, boutique. Deux exceptions, volontaires :

- il ne peut **pas** toucher a **Gerer Stripe Connect** : le compte bancaire reste entre vos mains
  et celles de l'administrateur de la plateforme ;
- il ne peut **pas** publier au nom de votre association : parler en votre nom n'est pas administrer.

---

## 4. Ce que les onglets de gestion demandent

L'onglet n'apparait que si vous avez le droit correspondant.

| Onglet | Droit necessaire |
|---|---|
| **Profil** | visible par tous les membres ; modifiable avec *Gerer les membres* |
| **Membres** | Gerer les membres |
| **Documents** | Gerer les documents |
| **Formulaires** | Gerer les formulaires |
| **Achats**, **Delegation** | Gerer les paiements (boutique) |
| **Cotisations** | Gerer les membres **ou** Gerer les paiements |
| **Paiements** | Gerer Stripe Connect **ou** Gerer les paiements |
| **Partenariats** | Gerer les partenariats |
| **Danger** | administrateur de la plateforme uniquement |

Les droits *Publier au nom de l'asso* et *Proposer des evenements* ne correspondent a aucun onglet :
ils agissent dans le fil d'actualites et dans l'agenda.

Une publication faite au nom de l'association appartient a l'association, pas a la personne qui l'a
redigee : **toute personne ayant *Publier au nom de l'asso* peut la modifier ou la supprimer**, et
une personne a qui ce droit est retire ne peut plus toucher a ce qu'elle avait publie. C'est
volontaire : le nom affiche est celui de l'asso, donc c'est l'asso qui en repond.

A noter : un membre du BDE qui administre les autres associations (*Gerer les associations*)
n'herite PAS de ce droit-la. Parler au nom d'une asso n'est pas l'administrer.

Le droit *Moderer* du BDE, lui, porte sur tout le fil : qui le detient peut modifier, supprimer et
epingler n'importe quelle publication, en plus de traiter les signalements et les mutes. C'est le
seul droit qui donne l'epingle.

---

## 5. Ne pas confondre avec les roles d'un channel

Les **channels** de messagerie ont leur propre systeme, sans rapport avec celui-ci : Membre,
Moderateur, Administrateur. Un droit d'association ne donne rien dans un channel, et
reciproquement. Voir le [guide membre](membre.md) pour les channels.

---

## Questions frequentes

**J'ai coche un droit et la personne ne voit toujours rien.**
Elle doit recharger la page : ses droits sont lus au chargement.

**Pourquoi ne vois-je pas les cases a cocher des autres membres ?**
Il faut le droit *Gerer les membres*. Sans lui, l'application ne recoit meme pas la liste des droits
des autres - elle ne peut donc pas la deviner, et le bouton reste desactive.

**Puis-je creer un nouveau droit ?**
Non, la liste des onze droits est fixee dans le code. Si un besoin n'est couvert par aucun,
signalez-le : c'est une evolution, pas un reglage.
