# Dossier pour la déléguée ou le délégué à la protection des données de l'École

**Rédigé le 16/10/2026 par l'association Rootz - EMSE, à la suite d'une revue RGPD de l'ensemble
des services qu'elle exploite.** Ce dossier est volontairement court : il pose les trois questions
auxquelles seul le DPO de l'École peut répondre, puis renvoie au registre et aux documents de
travail. Les pages liées sont en anglais (documentation technique du dépôt) ; nous pouvons en
fournir une version française sur demande.

Contact : `bureau@rootz-emse.fr` (Rootz), `bureau@mitv.fr` (MiTV, pour MiGallery).

## 1. Le périmètre

| Service | Ce qu'il fait | Responsable du traitement |
| --- | --- | --- |
| Canari | messagerie chiffrée de bout en bout et vie associative (fil, communautés, associations, formulaires, paiements via Lydia) | Rootz |
| MiConnect | service de connexion unique des associations, relié au CAS de l'École | Rootz |
| MiGallery | photothèque de MiTV, avec reconnaissance faciale (Immich) | MiTV |
| Sky | arbre du parrainage ICM | Rootz |
| Le Cercle | comptes et caisse du bar | à confirmer (Rootz ou l'association du Cercle) |
| Portail étudiant | vitrine publique des associations et de leurs membres | Rootz |

Tous fonctionnent sur **un serveur partagé de l'École administré avec la DSI** ; les sauvegardes
sont copiées sur une seconde machine de l'École ; quelques anciens noms de domaine passent encore
par Cloudflare.

## 2. Les trois questions qui vous reviennent

### Q1 - Quel est le rôle de l'École ?

L'École fournit l'identité (le CAS), l'hébergement et l'administration du serveur. Selon votre
analyse, elle est :

- **responsable conjoint** (art. 26) - il faut alors un accord répartissant les obligations
  (information, droits, violations) ;
- **sous-traitant** de l'association pour l'hébergement (art. 28) - il faut alors un contrat de
  sous-traitance ;
- ou un **simple fournisseur d'infrastructure**, sans accès aux données pour son propre compte.

Notre lecture, à confirmer : l'École n'utilise pas les données des services à ses propres fins, ce
qui orienterait vers le sous-traitant pour l'hébergement. Mais la DSI dispose des accès
d'administration du serveur.

### Q2 - Quelle convention d'hébergement avec la DSI ?

Aucune n'est écrite aujourd'hui. Nous proposons qu'elle couvre :

- qui accède aux données et dans quel cadre (administration, sécurité, outils de la DSI - pare-feu,
  protection des postes) ;
- l'information de l'association en cas d'incident de sécurité sur le serveur, et le délai (notre
  délai de 72 heures vis-à-vis de la CNIL en dépend) ;
- la localisation des sauvegardes et leur chiffrement ;
- la fin de l'hébergement (restitution, effacement).

### Q3 - Validez-vous l'AIPD de MiGallery ?

La reconnaissance faciale traite des données biométriques. Le consentement des membres a été
recueilli par un autre moyen que l'application, et MiTV doit en conserver la preuve. **Le risque
principal est le traitement des visages de personnes non membres** : Immich détecte et regroupe
tous les visages des photos, y compris ceux de personnes qui n'ont jamais été sollicitées. Nous
demandons votre avis sur les mesures proposées, et sur la nécessité d'une consultation préalable de
la CNIL (art. 36) si le risque résiduel reste élevé.

**Décision du 2026-10-24 (option C), pas encore construite :** la reconnaissance sort d'Immich.
MiGallery calcule, photo par photo, les empreintes des visages dans son propre traitement, avec une
image d'apprentissage automatique figée, et les range dans sa propre base chiffrée. **Aucun
regroupement, aucune « personne »** : un membre retrouve ses photos en comparant sa propre référence
au moment de la recherche. Les empreintes vivent aussi longtemps que la photo et sont exclues des
sauvegardes. Rien n'est construit avant une comparaison des modèles candidats. Le responsable
assume la question de l'article 9 qui demeure : les empreintes des personnes non membres sont
calculées et conservées tant que leur photo existe, mais ne sont jamais regroupées en une identité.
Votre avis sur ce choix nous importe. Document :
[dpia-migallery-faces](dpia-migallery-faces.md).

**Mise à jour du 2026-10-31 :** l'option C est construite dans MiGallery (le modèle buffalo_l est
gardé, les correspondances sont enregistrées plutôt que calculées à la recherche, l'analyse passe
par le service d'apprentissage automatique d'Immich sur un réseau interne dédié). La bascule
supprimera les visages, personnes et empreintes d'Immich, avec une copie chiffrée gardée 30 jours
puis supprimée. Le responsable a décidé d'aller au bout sans attendre votre avis, qu'il sollicite
toujours ; l'AIPD a été mise à jour sur les faits, et son évaluation reste à refaire par lui.

## 3. Le registre et les destinataires

Le registre des activités de traitement (art. 30), service par service, avec finalités, données,
personnes concernées, bases légales, durées et mesures de sécurité :
[register-of-processing](register-of-processing.md).

Destinataires hors de l'association, pour Canari :

| Destinataire | Données | Garanties de transfert |
| --- | --- | --- |
| Google Firebase (notifications Android et relais iOS) | jeton de l'appareil ; nom de l'expéditeur et du groupe en clair ; pour le fil, un extrait de 60 caractères | à confirmer |
| Apple (APNs) | jeton de l'appareil ; titre de la notification | à confirmer |
| Cloudflare (anciens noms de domaine) | requêtes et adresses IP | à confirmer |
| Google Safe Browsing | adresse des liens ouverts | à confirmer |
| KLIPY (GIF) | recherches et images de GIF, demandées par notre serveur (adresse du serveur et un identifiant constant pour la recherche ; adresse du serveur et un User-Agent seuls pour les images) ; l'adresse complète d'une image relayée (dont son URL et son ticket) figure dans les journaux du serveur nginx de l'hôte et de Cloudflare ; une version de l'application non mise à jour envoie encore l'adresse IP de l'appareil | à confirmer ; recherche par notre serveur depuis le 16/10/2026 ; images par notre serveur construit le 18/10/2026, en production avec la version suivante |
| Lydia | adresse e-mail du payeur, montant, produits | prestataire français |

## 4. Les points que nous vous signalons

1. **Cotisations des anciennes bases** : environ 1 400 personnes, pour la plupart sans compte
   (nom, prénom, promotion, association), conservées **sans date de fin** pour leur permettre de
   récupérer leur cotisation. Nous souhaitons votre avis sur une durée, et sur l'information de
   ces personnes (art. 14) : n'ayant pas de compte, la politique de Canari ne les atteint pas.
2. **Environnement de test** : il ne contient plus aucune donnée de la production depuis le
   2026-10-16 (des personnes et associations fictives, et les comptes des testeurs qui s'y
   connectent). Pour information ; plus de question sur ce point.
3. **Notifications** : le nom de l'expéditeur et du groupe part en clair vers Google et Apple ;
   c'est un choix technique assumé, déclaré dans la politique.
4. **Âge minimum** : 15 ans, fixé par référence à l'art. 45 de la loi Informatique et Libertés
   (qui vise le consentement, alors que nos bases sont le contrat et l'intérêt légitime : votre
   avis est bienvenu) ; pas de contrôle d'âge dans l'application, la population étant celle de
   l'École.
5. **Sauvegardes** : les bases sont gardées 14 jours, les fichiers (chiffrés côté client) jusqu'à
   6 mois ; le chiffrement des sauvegardes de bases est en cours.
6. **Journaux** : 90 jours au plus, mise en oeuvre en cours.
7. **Droits** : procédure manuelle par e-mail, réponse sous 30 jours, avec un registre des demandes
   ([data-subject-requests](data-subject-requests.md)). Violations : procédure et registre
   ([breach-procedure](breach-procedure.md)).

## 5. Ce que nous attendons de vous

- une réponse à Q1 et Q2, pour rédiger l'accord ou la convention ;
- un avis sur l'AIPD (Q3) ;
- un avis sur les points 1 et 2 de la section 4 ;
- toute remarque sur la politique de confidentialité de Canari : <https://canari.emse.fr/legal/privacy>.
