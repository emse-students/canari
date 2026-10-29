# Réservations - salles, instruments, rendez-vous

> Guide utilisateur. Le détail technique est dans
> [bookings-chantier](../wiki/bookings-chantier.md) (anglais).

Un **espace** est ce que l'on réserve : une salle de musique, un instrument à prêter, des
entretiens avec un intervenant. Un espace appartient à une association, à une liste, à une
institution, ou à vous seul (espace personnel).

Un espace contient une ou plusieurs **colonnes**. Une colonne est une salle, un instrument ou une
personne, avec ses propres horaires. **Un espace naît avec une seule colonne, cachée** : les
personnes qui réservent ne voient aucun nom de colonne, seulement l'espace. Si vous gérez plusieurs
salles ou plusieurs intervenants, vous ajoutez des colonnes (voir plus bas).

Ce guide a deux parties : [réserver](#réserver-membre) et [gérer un espace](#gérer-un-espace-organisateur).

---

## Réserver (membre)

### Trouver un espace

Ouvrez **Réservations**. La page montre :

- **Mes réservations à venir**, en haut. Celles qui sont passées, annulées ou que vous avez quittées
  sont repliées dans « Passées, annulées ou quittées ».
- **Espaces à réserver** : la liste des espaces ouverts à votre profil. Chaque ligne a la vignette de
  l'affiche de l'espace, ou un petit calendrier s'il n'en a pas, puis son nom et qui le gère.
- **Mes espaces personnels** (voir plus bas).

Un espace « sur lien uniquement » n'est dans aucune liste : il s'ouvre par son lien ou son QR code,
que son organisateur vous transmet. Un espace réservé à certaines personnes (une promotion, une
formation...) leur est seul ouvert : sinon, « Cet espace n'est pas ouvert à votre profil ».

### Choisir un créneau

- **Sur ordinateur**, l'espace s'affiche en **semaine** : les jours sont les colonnes, les heures
  les lignes. Les flèches changent de semaine, « Aujourd'hui » y revient. Un jour où rien n'est
  proposé se replie en une bande étroite.
- **Sur téléphone**, vous voyez **un jour à la fois**, avec la bande des sept jours de la semaine
  au-dessus. Un point sur chaque jour dit s'il reste des créneaux libres.
- **Plusieurs colonnes** : un sélecteur « Colonne » apparaît, avec le nombre de créneaux libres de
  chacune. Avec une seule colonne, il n'y en a pas.
- Chaque case dit son état : **Libre**, **Occupé**, **Ma réservation**, **Indisponible** (un
  gestionnaire l'a fermée) ou **Non réservable**.
- Les horaires sont toujours ceux de l'espace (son fuseau est rappelé sous la grille), quel que soit
  l'endroit où vous êtes.

Touchez une case libre. Si l'espace propose des **créneaux fixes**, le créneau se réserve en entier.
S'il propose des **pas réguliers** (par exemple des tranches de 30 minutes), vous choisissez la
durée : **glissez sur la grille** pour couvrir plusieurs pas qui se suivent (sur téléphone, **posez
le doigt environ un quart de seconde** avant de glisser, pour ne pas confondre avec un défilement),
ou réglez le champ « Jusqu'à » dans la fenêtre « Réserver ». L'organisateur peut limiter le nombre
de pas.

### Réserver

La fenêtre « Réserver » peut demander :

- **Autres personnes** : des comptes Canari à ajouter à la réservation (jusqu'au maximum fixé par
  l'espace, vous compris). Elles sont ajoutées directement, **sans être prévenues** : elles la
  verront sur Réservations et pourront s'en retirer. Quelqu'un qui vous a bloqué, ou que vous avez
  bloqué, ne peut pas être ajouté.
- **Les questions de l'organisateur** (texte, choix...). Une question « fichier » accepte un PDF, un
  JPEG, un PNG ou un WebP de 8 Mo au plus. Il part dès que vous le choisissez, et le bouton
  « Réserver » attend la fin de l'envoi. Seuls les gestionnaires de l'espace peuvent le lire, et il
  est supprimé automatiquement quelques jours après la fin du créneau (le nombre est indiqué sous la
  question).

Une fois la réservation faite, l'espace peut afficher une **information après réservation** (un
code de salle, un lien de visio) : elle n'est visible que des personnes de la réservation, tant
qu'elle existe.

Si quelqu'un prend le créneau avant vous, l'application vous le dit (« Ce créneau vient d'être
réservé par quelqu'un d'autre ») et la grille se met à jour. L'espace peut aussi refuser pour une de
ses règles : ouverture pas encore atteinte, créneau trop proche ou trop lointain, trop de
réservations à venir, durée maximale atteinte.

**Une réservation ne se modifie pas.** Pour changer une réponse, un fichier ou les personnes,
annulez puis réservez à nouveau (le créneau peut être pris entre-temps).

### Mes réservations

Chaque réservation à venir affiche votre rôle (**Titulaire**, **Participant**, ou **Votre colonne**
si vous êtes la personne liée à la colonne), les personnes qui y sont, et le bouton d'ajout à votre
calendrier (**Ajouter à mon calendrier**).

- Le **titulaire** peut **Annuler la réservation** jusqu'à son début.
- Un **participant** peut **Me retirer** : la réservation reste celle de son titulaire. L'espace peut
  fixer un délai (« jusqu'à X minutes avant ») ; passé ce délai, on ne peut plus se retirer.
- Une fois qu'une réservation a commencé, elle ne se modifie plus : c'est l'historique.
- **Personne n'est prévenu** d'une annulation ou d'un ajout : l'application l'écrit à l'écran. Vous
  le découvrez en revenant sur Réservations.

### Mes espaces personnels

**Mes espaces personnels** permet de proposer vous-même des créneaux : des entretiens, un
instrument à prêter. Donnez un nom, **Créer l'espace**, puis réglez-le comme n'importe quel espace
(voir ci-dessous). Si le propriétaire d'un espace personnel supprime son compte, les réservations à
venir de cet espace disparaissent sans avertissement.

---

## Gérer un espace (organisateur)

### Qui peut créer et gérer

Dans une association, une liste ou une institution, il faut le droit **Gérer les réservations** (voir
[Les permissions d'une association](permissions-association.md)). L'onglet **Réservations** de
l'entité liste ses espaces : saisissez le **Nom du nouvel espace**, **Créer l'espace**, puis
**Modifier**. Un espace personnel se crée depuis la page Réservations.

Sur la page d'un espace, tout le monde dispose de **Copier le lien de l'espace** et du **QR code**
(son scan ouvre la page de réservation) ; un gestionnaire voit en plus **Gérer l'espace**.

Les réglages se font en cinq sections dépliables. Chaque titre porte, sur une ligne en dessous, la
**réponse actuelle** de la section (par exemple « Colonnes : 2 », « noms cachés », « lien
seulement »), qui suit vos changements avant même l'enregistrement. Les deux dernières sections sont
repliées. L'application prévient si vous quittez avec des modifications non enregistrées.

### L'essentiel

Le **nom**, la **description**, l'**affiche** et le **fuseau horaire**. L'affiche (JPEG, PNG ou
WebP) est chiffrée sur votre appareil comme l'image d'une publication, et enregistrée dès que vous
la choisissez, sans passer par le bouton d'enregistrement (Choisir, Remplacer ou Retirer l'affiche).
Le fuseau est celui dans lequel tout le monde lit les horaires.

### Quand peut-on réserver ?

**Les horaires.** Pour chaque colonne, la section « Disponibilités » propose :

1. **Partir d'un modèle** : *Toujours ouvert* (24 h/24, 7 j/7), *Jours ouvrés 8h-20h* (du lundi au
   vendredi), *Événement ponctuel* (une ou quelques dates) ou *Vide* (« Je peins moi-même »). Un
   modèle remplace la semaine type ; rien n'est enregistré avant le bouton.
2. **La semaine type**, à peindre : **glissez pour ouvrir** des horaires, ou **partez d'une zone
   verte pour fermer**. Un trait fait 30 minutes.
3. **En clair** : les mêmes horaires écrits, à la minute près, tels que les verront les réservants.
   Vous pouvez aussi les saisir ici : c'est la voie au clavier, et pour une heure exacte. « Finit le
   lendemain » permet une plage de nuit.
4. **Les dates ponctuelles** (« Ajouter une date ») : une date et ses heures, en plus de la semaine
   type, pour un événement.
5. **Fermetures** (« Ajouter une fermeture », du ... au ...) : des périodes où rien ne se réserve
   (vacances, travaux).

Puis **Enregistrer les disponibilités**. Un avertissement apparaît si plusieurs journées entières se
suivent : une réservation ne peut pas passer minuit entre deux journées entières ; pour permettre
une nuit, écrivez une plage du soir qui finit le lendemain matin.

**Le découpage du temps**, au choix :

- **Pas réguliers** : chaque plage est découpée en pas (durée d'un pas en minutes) ; une réservation
  prend un ou plusieurs pas qui se suivent, jusqu'à un maximum que vous fixez.
- **Créneaux fixes** : chaque plage est un créneau, réservé en entier.

**Les colonnes.** Tant qu'il n'y a qu'une colonne, vous réglez directement ses horaires. La carte
« Une seule colonne » propose **Ajouter une colonne** (nommez-la, puis **Ajouter la colonne**) si
vous gérez plusieurs salles, instruments ou personnes : les colonnes apparaissent alors pour les
réservants, chacune avec ses horaires, et vous pouvez les renommer ou les supprimer. Tant qu'il n'y
a qu'une colonne portant le nom de l'espace, elle suit l'espace quand vous le renommez. Une colonne
peut être liée à un **compte** (un enseignant, un intervenant) : cette personne voit les
réservations de sa colonne et peut la rendre indisponible. Une colonne déjà réservée ne peut pas
être supprimée (son historique est conservé) : on la ferme en retirant ses plages ou en ajoutant une
fermeture.

**Changer les horaires quand des réservations existent.** Si des réservations à venir tombent dans
ce que vous retirez, l'enregistrement est **refusé** : la section « Les réservations en travers »
les liste, chacune avec un bouton **Annuler**. Annulez celles qui doivent partir, puis **Enregistrer
de nouveau**. Les personnes concernées ne sont pas prévenues : prévenez-les vous-même.

### Qui peut réserver, et que demande-t-on ?

- **Réserver à certaines personnes** : désactivé, tout compte connecté peut réserver ; activé, vous
  fixez des critères (promotion, formation, cotisation, comme dans les formulaires).
- **Ce que voient les autres** : **Les noms**, ou **Seulement « occupé »** (alors seuls
  l'organisateur et les personnes de la réservation voient les noms). Les réponses et les fichiers
  ne sont jamais visibles des autres réservants.
- **Comment on trouve l'espace** : **Listé pour son audience** (dans la page Réservations, pour les
  personnes autorisées) ou **Sur lien uniquement** (aucune liste ; il s'ouvre par le lien ou le QR
  code). Dans les deux cas, l'audience est contrôlée par le serveur.
- **Personnes par réservation, au plus** (celui qui réserve est compté ; vide, pas de limite) et
  **Informations après réservation** (un code, un lien de visio, visibles des seules personnes de la
  réservation).
- **Les questions**, construites comme celles d'un formulaire, plus la question **fichier**.

### Règles de réservation (repliée)

Un badge indique combien de règles sont actives. Toutes sont facultatives :

- **Ouverture des réservations** (une date, à l'heure de l'espace) ;
- **Préavis minimal** (en minutes) et **Horizon** (combien de jours à l'avance) ;
- **Réservations à venir par personne** ;
- **Durée maximale par personne**, par jour ou par semaine ;
- **Retrait d'un participant, jusqu'à (minutes avant)** : 0 signifie jusqu'au début. Le titulaire peut
  toujours annuler.

### Données (repliée)

- **Suppression des réponses** : les réponses et les fichiers sont supprimés de 1 à 30 jours après
  la fin du créneau. Une réservation elle-même est supprimée un an après la fin de son créneau.
- **Exporter (.xlsx)** : toutes les réservations de l'espace dans un tableur, annulées comprises
  (date, début, fin, ressource, titulaire, participants, statut). Un fichier joint y figure par un
  mot, jamais par son contenu.
- **Supprimer l'espace** : tout part avec lui, colonnes, disponibilités **et historique des
  réservations**. Les réservations à venir disparaissent et leurs personnes ne sont **pas
  prévenues** : prévenez-les d'abord. C'est définitif.

### Au jour le jour

Sur la grille de l'espace, un gestionnaire (ou la personne liée à une colonne, pour sa colonne) peut :

- **Marquer indisponible** une plage libre, depuis la fenêtre qui s'ouvre sur une case libre : on
  choisit « Jusqu'à », une raison facultative et si on la montre (sinon les autres lisent
  « Indisponible »). Une indisponibilité qui recouvrirait des réservations à venir est refusée :
  annulez-les d'abord. **Lever l'indisponibilité** la retire.
- **Réserver pour quelqu'un** (gestionnaires seulement) : l'option « Réserver pour quelqu'un » met la
  réservation au nom de la personne choisie, hors limites par personne.
- **Annuler** une réservation à venir en l'ouvrant dans la grille. Son titulaire n'est pas prévenu.

Pour lire un fichier reçu, ouvrez la réservation dans la grille : la réponse affiche le nom du
fichier et un bouton de téléchargement, réservé aux gestionnaires de l'espace.
