# Reservations - salles, instruments, rendez-vous

> Guide utilisateur. Le detail technique est dans
> [bookings-chantier](../wiki/bookings-chantier.md) (anglais).

Un **espace** est ce que l'on reserve : une salle de musique, un instrument a preter, des
entretiens avec un intervenant. Un espace appartient a une association, a une liste, a une
institution, ou a vous seul (espace personnel).

Un espace contient une ou plusieurs **colonnes**. Une colonne est une salle, un instrument ou une
personne, avec ses propres horaires. **Un espace nait avec une seule colonne, cachee** : les
personnes qui reservent ne voient aucun nom de colonne, seulement l'espace. Si vous gerez plusieurs
salles ou plusieurs intervenants, vous ajoutez des colonnes (voir plus bas).

Ce guide a deux parties : [reserver](#reserver-membre) et [gerer un espace](#gerer-un-espace-organisateur).

---

## Reserver (membre)

### Trouver un espace

Ouvrez **Reservations**. La page montre :

- **Mes reservations a venir**, en haut. Celles qui sont passees, annulees ou que vous avez quittees
  sont repliees dans " Passees, annulees ou quittees ".
- **Espaces a reserver** : la liste des espaces ouverts a votre profil. Chaque ligne a la vignette de
  l'affiche de l'espace, ou un petit calendrier s'il n'en a pas, puis son nom et qui le gere.
- **Mes espaces personnels** (voir plus bas).

Un espace " sur lien uniquement " n'est dans aucune liste : il s'ouvre par son lien ou son QR code,
que son organisateur vous transmet. Un espace reserve a certaines personnes (une promotion, une
formation...) leur est seul ouvert : sinon, " Cet espace n'est pas ouvert a votre profil ".

### Choisir un creneau

- **Sur ordinateur**, l'espace s'affiche en **semaine** : les jours sont les colonnes, les heures
  les lignes. Les fleches changent de semaine, " Aujourd'hui " y revient. Un jour ou rien n'est
  propose se replie en une bande etroite.
- **Sur telephone**, vous voyez **un jour a la fois**, avec la bande des sept jours de la semaine
  au-dessus. Un point sur chaque jour dit s'il reste des creneaux libres.
- **Plusieurs colonnes** : un selecteur " Colonne " apparait, avec le nombre de creneaux libres de
  chacune. Avec une seule colonne, il n'y en a pas.
- Chaque case dit son etat : **Libre**, **Occupe**, **Ma reservation**, **Indisponible** (un
  gestionnaire l'a fermee) ou **Non reservable**.
- Les horaires sont toujours ceux de l'espace (son fuseau est rappele sous la grille), quel que soit
  l'endroit ou vous etes.

Touchez une case libre. Si l'espace propose des **creneaux fixes**, le creneau se reserve en entier.
S'il propose des **pas reguliers** (par exemple des tranches de 30 minutes), vous choisissez la
duree : **glissez sur la grille** pour couvrir plusieurs pas qui se suivent (sur telephone, **posez
le doigt environ un quart de seconde** avant de glisser, pour ne pas confondre avec un defilement),
ou reglez le champ " Jusqu'a " dans la fenetre " Reserver ". L'organisateur peut limiter le nombre
de pas.

### Reserver

La fenetre " Reserver " peut demander :

- **Autres personnes** : des comptes Canari a ajouter a la reservation (jusqu'au maximum fixe par
  l'espace, vous compris). Elles sont ajoutees directement et **prevenues par une notification** :
  elles la verront sur Reservations et pourront s'en retirer. Quelqu'un qui vous a bloque, ou que vous avez
  bloque, ne peut pas etre ajoute.
- **Les questions de l'organisateur** (texte, choix...). Une question " fichier " accepte un PDF, un
  JPEG, un PNG ou un WebP de 8 Mo au plus. Il part des que vous le choisissez, et le bouton
  " Reserver " attend la fin de l'envoi. Seuls les gestionnaires de l'espace peuvent le lire, et il
  est supprime automatiquement quelques jours apres la fin du creneau (le nombre est indique sous la
  question).

Une fois la reservation faite, l'espace peut afficher une **information apres reservation** (un
code de salle, un lien de visio) : elle n'est visible que des personnes de la reservation, tant
qu'elle existe.

Si quelqu'un prend le creneau avant vous, l'application vous le dit (" Ce creneau vient d'etre
reserve par quelqu'un d'autre ") et la grille se met a jour. L'espace peut aussi refuser pour une de
ses regles : ouverture pas encore atteinte, creneau trop proche ou trop lointain, trop de
reservations a venir, duree maximale atteinte.

**Une reservation ne se modifie pas.** Pour changer une reponse, un fichier ou les personnes,
annulez puis reservez a nouveau (le creneau peut etre pris entre-temps).

### Mes reservations

Chaque reservation a venir affiche votre role (**Titulaire**, **Participant**, ou **Votre colonne**
si vous etes la personne liee a la colonne), les personnes qui y sont, et le bouton d'ajout a votre
calendrier (**Ajouter a mon calendrier**).

- Le **titulaire** peut **Annuler la reservation** jusqu'a son debut.
- Un **participant** peut **Me retirer** : la reservation reste celle de son titulaire. L'espace peut
  fixer un delai (" jusqu'a X minutes avant ") ; passe ce delai, on ne peut plus se retirer.
- Une fois qu'une reservation a commence, elle ne se modifie plus : c'est l'historique.
- **Vous etes prevenu par une notification** quand l'organisateur annule une reservation ou vous
  etes (avec son message s'il en laisse un), quand le titulaire annule une reservation ou vous etes
  participant, quand un participant se retire de la votre et quand quelqu'un vous ajoute a une
  reservation. Personne n'est prevenu de son propre geste. Ces notifications se reglent dans les
  reglages, categorie **Reservations**.
- **Un rappel** arrive avant le creneau. Par defaut, c'est celui choisi par l'espace ; le **Rappel**
  se change dans la fenetre " Reserver " et sur chaque reservation a venir : 15 min, 1 h, la veille
  (24 h avant) ou pas de rappel. Une reservation faite plus tard que ce delai n'a pas de rappel.

### Mes espaces personnels

**Mes espaces personnels** permet de proposer vous-meme des creneaux : des entretiens, un
instrument a preter. Donnez un nom, **Creer l'espace**, puis suivez l'assistant ou reglez-le comme
n'importe quel espace (voir ci-dessous). Si le proprietaire d'un espace personnel supprime son compte, les reservations a
venir de cet espace disparaissent sans avertissement.

---

## Gerer un espace (organisateur)

### Qui peut creer et gerer

Dans une association, une liste ou une institution, il faut le droit **Gerer les reservations** (voir
[Les permissions d'une association](permissions-association.md)). L'onglet **Reservations** de
l'entite liste ses espaces : saisissez le **Nom du nouvel espace** puis **Creer l'espace**. Un
espace personnel se cree depuis la page Reservations, de la meme facon.

**L'assistant de creation** s'ouvre alors, en trois etapes :

1. **C'est quoi ?** - le nom, une phrase (facultatif), une affiche (facultatif).
2. **Quand ?** - un modele (*Toujours ouvert*, *Jours ouvres 8h-20h*, *Evenement ponctuel*, *Vide*)
   puis la semaine a peindre, ou la date de l'evenement ; et la duree d'une reservation : **Au
   choix** (jusqu'a une duree, par pas) ou **Creneaux fixes** (tous de la meme duree, decoupes dans
   les heures choisies).
3. **Pour qui ?** - tout le monde sur Canari ou seulement certaines personnes (promo, formation,
   cotisation), si les autres voient qui a reserve, et si l'espace est dans la liste ou accessible
   par lien ou QR code seulement.

**Creer l'espace** l'enregistre en une fois et ouvre ses reglages, ou tout le reste (fermetures,
colonnes, questions, regles) se precise ensuite. **Je regle tout moi-meme** saute l'assistant :
l'espace est cree avec son seul nom, et tout se regle dans les cinq sections ci-dessous.

Sur la page d'un espace, tout le monde dispose de **Copier le lien de l'espace** et du **QR code**
(son scan ouvre la page de reservation) ; un gestionnaire voit en plus **Gerer l'espace**.

Les reglages se font en cinq sections depliables. Chaque titre porte, sur une ligne en dessous, la
**reponse actuelle** de la section (par exemple " Colonnes : 2 ", " noms caches ", " lien
seulement "), qui suit vos changements avant meme l'enregistrement. Les deux dernieres sections sont
repliees. L'application previent si vous quittez avec des modifications non enregistrees.

### L'essentiel

Le **nom**, la **description**, l'**affiche** et le **fuseau horaire**. L'affiche (JPEG, PNG ou
WebP) est chiffree sur votre appareil comme l'image d'une publication, et enregistree des que vous
la choisissez, sans passer par le bouton d'enregistrement (Choisir, Remplacer ou Retirer l'affiche).
Le fuseau est celui dans lequel tout le monde lit les horaires.

### Quand peut-on reserver ?

**Les horaires.** Pour chaque colonne, la section " Disponibilites " propose :

1. **Partir d'un modele** : *Toujours ouvert* (24 h/24, 7 j/7), *Jours ouvres 8h-20h* (du lundi au
   vendredi), *Evenement ponctuel* (une ou quelques dates) ou *Vide* (" Je peins moi-meme "). Un
   modele remplace la semaine type ; rien n'est enregistre avant le bouton. *Evenement ponctuel* vide la semaine et ajoute une seule date a remplir si la liste n'en a pas deja une.
2. **La semaine type**, a peindre : **glissez pour ouvrir** des horaires, ou **partez d'une zone
   verte pour fermer**. Un trait fait 30 minutes.
3. **En clair** : les memes horaires ecrits, a la minute pres, tels que les verront les reservants.
   Vous pouvez aussi les saisir ici : c'est la voie au clavier, et pour une heure exacte. " Finit le
   lendemain " permet une plage de nuit.
4. **Les dates ponctuelles** (" Ajouter une date ") : une date et ses heures, en plus de la semaine
   type, pour un evenement.
5. **Fermetures** (" Ajouter une fermeture ", du ... au ...) : des periodes ou rien ne se reserve
   (vacances, travaux).

Puis **Enregistrer les disponibilites**. Un avertissement apparait si plusieurs journees entieres se
suivent : une reservation ne peut pas passer minuit entre deux journees entieres ; pour permettre
une nuit, ecrivez une plage du soir qui finit le lendemain matin.

**Le decoupage du temps**, au choix :

- **Pas reguliers** : chaque plage est decoupee en pas (duree d'un pas en minutes) ; une reservation
  prend un ou plusieurs pas qui se suivent, jusqu'a un maximum que vous fixez.
- **Creneaux fixes** : chaque plage est un creneau, reserve en entier. Sur un tel espace, la
  semaine type se peint **creneau par creneau** : appuyer sur une case fermee ouvre un creneau entier
  (de la duree la plus courante de vos creneaux, 30 minutes par defaut), appuyer sur un creneau le
  ferme en entier, et deux creneaux qui se touchent ne sont **jamais fusionnes**.

**Les colonnes.** Tant qu'il n'y a qu'une colonne, vous reglez directement ses horaires. La carte
" Une seule colonne " propose **Ajouter une colonne** (nommez-la, puis **Ajouter la colonne**) si
vous gerez plusieurs salles, instruments ou personnes : les colonnes apparaissent alors pour les
reservants, chacune avec ses horaires, et vous pouvez les renommer ou les supprimer. Tant qu'il n'y
a qu'une colonne portant le nom de l'espace, elle suit l'espace quand vous le renommez. Une colonne
peut etre liee a un **compte** (un enseignant, un intervenant) : cette personne voit les
reservations de sa colonne et peut la rendre indisponible. Une colonne deja reservee ne peut pas
etre supprimee (son historique est conserve) : on la ferme en retirant ses plages ou en ajoutant une
fermeture.

**Changer les horaires quand des reservations existent.** Si des reservations a venir tombent dans
ce que vous retirez, l'enregistrement est **refuse** : la section " Les reservations en travers "
les liste, chacune avec un bouton **Annuler**. Annulez celles qui doivent partir, puis **Enregistrer
de nouveau**. Les personnes concernees sont prevenues par une notification.

### Qui peut reserver, et que demande-t-on ?

- **Reserver a certaines personnes** : desactive, tout compte connecte peut reserver ; active, vous
  fixez des criteres (promotion, formation, cotisation, comme dans les formulaires).
- **Ce que voient les autres** : **Les noms**, ou **Seulement " occupe "** (alors seuls
  l'organisateur et les personnes de la reservation voient les noms). Les reponses et les fichiers
  ne sont jamais visibles des autres reservants.
- **Comment on trouve l'espace** : **Liste pour son audience** (dans la page Reservations, pour les
  personnes autorisees) ou **Sur lien uniquement** (aucune liste ; il s'ouvre par le lien ou le QR
  code). Dans les deux cas, l'audience est controlee par le serveur.
- **Personnes par reservation, au plus** (celui qui reserve est compte ; vide, pas de limite) et
  **Informations apres reservation** (un code, un lien de visio, visibles des seules personnes de la
  reservation).
- **Les questions**, construites comme celles d'un formulaire, plus la question **fichier**.

### Regles de reservation (repliee)

Un badge indique combien de regles sont actives. Toutes sont facultatives :

- **Ouverture des reservations** (une date, a l'heure de l'espace) ;
- **Preavis minimal** (en minutes) et **Horizon** (combien de jours a l'avance) ;
- **Reservations a venir par personne** ;
- **Duree maximale par personne**, par jour ou par semaine ;
- **Retrait d'un participant, jusqu'a (minutes avant)** : 0 signifie jusqu'au debut. Le titulaire peut
  toujours annuler.
- **Rappel envoye avant le creneau** : le rappel par defaut de chaque personne d'une reservation
  (1 h si vous n'y touchez pas) ; chacune peut changer le sien.

### Donnees (repliee)

- **Suppression des reponses** : les reponses et les fichiers sont supprimes de 1 a 30 jours (7 par defaut) apres
  la fin du creneau. Une reservation elle-meme est supprimee un an apres la fin de son creneau.
- **Exporter (.xlsx)** : toutes les reservations de l'espace dans un tableur, annulees comprises
  (date, debut, fin, ressource, titulaire, participants, statut). Un fichier joint y figure par un
  mot, jamais par son contenu.
- **Supprimer l'espace** : tout part avec lui, colonnes, disponibilites **et historique des
  reservations**. Les reservations a venir disparaissent et leurs personnes en sont
  **prevenues** par une notification. C'est definitif.

### Au jour le jour

Sur la grille de l'espace, un gestionnaire (ou la personne liee a une colonne, pour sa colonne) peut :

- **Marquer indisponible** une plage libre, depuis la fenetre qui s'ouvre sur une case libre : on
  choisit " Jusqu'a ", une raison facultative et si on la montre (sinon les autres lisent
  " Indisponible "). Une indisponibilite qui recouvrirait des reservations a venir est refusee :
  annulez-les d'abord. **Lever l'indisponibilite** la retire.
- **Reserver pour quelqu'un** (gestionnaires seulement) : l'option " Reserver pour quelqu'un " met la
  reservation au nom de la personne choisie, hors limites par personne.
- **Annuler** une reservation a venir en l'ouvrant dans la grille, ou depuis " A venir " sur le
  tableau de bord, qui permet d'y joindre un message. Son titulaire et ses participants sont
  prevenus.

Pour lire un fichier recu, ouvrez la reservation dans la grille : la reponse affiche le nom du
fichier et un bouton de telechargement, reserve aux gestionnaires de l'espace.
