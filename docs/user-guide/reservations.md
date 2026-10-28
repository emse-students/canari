# Reservations - salles, creneaux, rendez-vous

> Guide utilisateur. Le detail technique est dans
> [bookings-chantier](../wiki/bookings-chantier.md) (anglais).

Un **espace de reservation** regroupe des **ressources** que l'on reserve par creneau. Une
ressource peut etre une salle, un objet, ou une personne qui recoit sur rendez-vous. Un espace
appartient a une association, ou a vous seul (espace personnel).

## Reserver (membre)

1. Ouvrez **Reservations**. Vos reservations a venir sont en haut. Les espaces proposes pour vous
   sont en dessous. Un espace "par lien seulement" n'y figure pas : il s'ouvre par son lien ou son
   QR code.
2. Dans l'espace, touchez un creneau libre de la grille. Selon l'espace, choisissez la duree,
   ajoutez des participants et repondez aux questions.
3. **Question "fichier"** : le fichier (PDF, JPEG, PNG ou WebP, 8 Mo au plus) part des que vous le
   choisissez. Le bouton de reservation attend la fin de l'envoi. Le fichier est lisible par les
   gestionnaires de l'espace seulement, et supprime automatiquement quelques jours apres la fin du
   creneau (le nombre de jours est indique sous la question).
4. Une reservation ne se modifie pas : annulez-la et reservez de nouveau.

## Gerer un espace (organisateur)

Depuis l'onglet **Reservations** de l'association (droit "gerer les reservations"), ou depuis
Reservations pour un espace personnel.

- **General** : nom, description, **affiche**, fuseau horaire. L'affiche (JPEG, PNG ou WebP) est
  chiffree sur votre appareil, comme l'image d'une publication. Elle est enregistree des que vous la
  choisissez, sans passer par le bouton d'enregistrement.
- **Ressources et disponibilites** : semaine type, exceptions, pas regulier ou creneaux fixes. Un
  espace nait avec **une seule colonne, invisible** : vous reglez directement ses horaires, et les
  membres ne voient aucun nom de colonne. **Ajouter une colonne** (plusieurs salles, instruments ou
  personnes) fait apparaitre les colonnes, chacune avec ses horaires. Tant qu'il n'y a qu'une
  colonne, elle porte le nom de l'espace et le suit quand vous le renommez.
- **Qui et comment** : public autorise, noms visibles ou non, espace liste ou par lien, questions.
  Les questions "fichier" sont acceptees.
- **Regles de reservation** : ouverture, delai de prevenance, horizon, quotas, nombre de personnes.
- **Donnees** :
  - **Suppression des reponses** : les reponses et les fichiers sont supprimes ce nombre de jours
    (1 a 30) apres la fin du creneau. Une reservation elle-meme est supprimee un an apres.
  - **Exporter (.xlsx)** : toutes les reservations de l'espace dans un tableur, annulees comprises.
    Un fichier y figure par le mot "Fichier", ou "Fichier supprime" une fois purge.
  - **Supprimer l'espace** : tout part avec lui, historique compris.

Pour lire un fichier recu, ouvrez la reservation dans la grille : la reponse affiche le nom du
fichier et un bouton de telechargement.
