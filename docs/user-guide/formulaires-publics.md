# Formulaires publics : faire payer des personnes sans compte

> Pour les responsables d'association qui organisent un evenement ouvert a l'exterieur
> (soiree, gala, tournoi...) et veulent encaisser l'inscription de personnes qui n'ont pas
> de compte Canari. Documentation technique : [forms](../wiki/frontend/modules/forms.md#a-public-form-is-answered-without-an-account-2026-09-30).

## Ce qu'est un formulaire public

Un formulaire **public** se remplit depuis un simple lien (`.../f/...`), sans compte ni
connexion. Toute personne qui a le lien peut repondre, autant de fois qu'elle veut. Un membre
connecte qui ouvre ce lien est renvoye vers la page habituelle du formulaire.

Un invite peut **payer** comme un membre :

- un **prix** fixe ;
- des **supplements** sur les options (ex. : "+3 EUR pour le repas") ;
- une **grille de prix selon les reponses** (ex. : menu vegetarien 10 EUR, menu viande 12 EUR) ;
- en **ligne** (Lydia) ou en **especes** si vous l'autorisez.

Ce qui reste **impossible** sur un formulaire public, parce qu'un invite n'a ni compte ni profil :

- accorder une **cotisation** ;
- une grille de prix selon la **promo**, la **formation** ou la **cotisation** ;
- restreindre le **public** (promo, formation, cotisants...) ;
- une question **fichier** (CV, justificatif...).

L'editeur vous le dit : l'interrupteur "Formulaire public" reste grise tant qu'un de ces
reglages est actif, avec la raison en dessous.

## Mettre un formulaire en public

1. Creez ou modifiez le formulaire (onglet **Formulaires** de l'association).
2. Reglez le prix, les supplements, la grille sur les reponses et le paiement en especes
   comme pour un formulaire normal, avec deux obligations propres au formulaire public :
   - si vous acceptez les especes, **fixez un delai de paiement en especes** (obligatoire : une
     reponse en especes non payee garde sa place jusqu'a ce delai) ;
   - avec une grille de prix, la case **"tous les autres"** ne peut pas valoir 0 si un invite
     peut y tomber (question de prix facultative, masquee par une autre reponse, ou option rangee
     dans aucun groupe) : donnez-lui un prix ou marquez-la indisponible.
3. Dans **Parametres avances**, activez **"Formulaire public"**. Les reponses multiples
   s'activent toutes seules : un invite peut repondre plusieurs fois.
4. **Ajoutez une question "Nom prenom"** (obligatoire) : c'est la seule facon de savoir qui a
   repondu, Canari ne connait pas l'invite.
5. Partagez le lien ou le QR code du formulaire : pour un formulaire public, ils menent a la
   page sans compte.

## Ce que voit l'invite

- Il remplit le formulaire et voit le **total** a payer.
- **En ligne** : il saisit une **adresse e-mail** (celle ou Lydia envoie la demande de
  paiement ; Canari ne la conserve pas), puis paie sur la page de Lydia. Il revient ensuite
  sur une page qui verifie le paiement aupres de Lydia et affiche une **reference**
  (ex. `1A2B-3C4D`). **Aucun e-mail de confirmation n'est envoye** : l'invite doit noter sa
  reference. Le lien de cette page reste valable : il peut y revenir si le paiement met du
  temps a se confirmer.
- **En especes** : la reponse est enregistree tout de suite, avec la somme due et la
  **reference** a vous donner.

## Retrouver un invite et valider ses especes

- Dans la liste des reponses, un invite qui a paye ou doit payer apparait comme
  **"Invite - 1A2B-3C4D"** : c'est la reference qu'il vous donne. Sa question "Nom prenom"
  dit qui il est.
- Les **especes** se valident comme pour un membre : **"Valider"** une fois l'argent recu.
- Dans l'onglet **Achats** de l'association, un paiement d'invite apparait au nom de
  **"Invite"**.

## Limites a connaitre

- **Une place est retenue pendant le paiement.** Une reponse en ligne non payee bloque sa
  place 30 minutes, puis la libere. Une reponse en especes bloque sa place jusqu'a la date
  limite de paiement en especes que vous avez fixee.
- **Un paiement arrive au-dela de la capacite n'est pas signale pour l'instant** : seul le
  tableau des reponses le montre (en tete, "paye hors capacite"). Regardez-le apres l'evenement.
- **Trois reponses en attente au plus par reseau.** Un meme reseau (une meme adresse IPv4, ou
  un meme reseau IPv6 /64, c'est-a-dire en pratique une meme box ou un meme Wi-Fi) ne peut pas
  avoir plus de trois reponses payantes en attente de paiement sur un formulaire : cela empeche
  un robot de bloquer toutes les places. Dans une salle ou tout le monde partage le meme Wi-Fi,
  le quatrieme invite doit attendre qu'une des trois soit payee (ou expire), ou repasser un peu
  plus tard. Canari ne garde pas l'adresse, seulement une empreinte effacee une fois la reponse
  reglee.
- **Un paiement arrive trop tard** (apres la liberation de la place, sur un formulaire
  complet) apparait en tete des reponses comme "paye hors capacite" : c'est a vous de
  **rembourser** l'invite en dehors de Canari (Canari ne rembourse pas).
- Un invite qui ferme la page avant la fin n'a pas de recu : il vous retrouvera par ses
  reponses (son nom).

## Questions frequentes

**L'invite a paye mais sa page dit "en cours de confirmation".**
Lydia n'a pas encore confirme. La page reverifie d'elle-meme ; l'invite peut aussi rouvrir
le meme lien quelques minutes plus tard. Si votre association a renseigne sa **"Cle privee Business Lydia"**
(onglet Paiements), Lydia confirme aussi le paiement directement, sans que l'invite revienne ;
sans cette cle, seul le retour de l'invite sur sa page confirme le paiement.

**Un invite a perdu sa reference.**
Cherchez sa reponse par son nom dans la liste des reponses : la reference est affichee a
cote de "Invite".

**Pourquoi l'interrupteur "Formulaire public" est-il grise ?**
Le formulaire accorde une cotisation, a une grille de prix selon la promo, la formation ou
la cotisation, restreint son public, ou pose une question fichier. Retirez ce reglage.
