# Comprendre le chiffrement de vos messages

> Pour toute personne qui utilise Canari, sans connaissance technique. Ce guide explique ce qui est
> protégé, contre qui, et - aussi clairement - ce qui ne l'est pas. Il se lit d'une traite.

## L'idée en une minute

Vos messages sont **fermés à clé avant de quitter votre appareil**, et ils ne sont **rouverts que sur
les appareils des personnes de la conversation**. Le serveur de Canari transporte et garde des
messages fermés : il n'a pas la clé pour les lire.

Cette protection a un prix, que ce guide explique : **puisque le serveur ne peut pas lire vos
messages, il ne peut pas non plus les "récupérer" pour vous**. La clé vit sur vos appareils, et c'est
pour cela que certaines situations (nouveau téléphone, PIN oublié) demandent un peu de patience, ou
un sacrifice.

## Deux mécanismes, selon l'endroit où vous écrivez

Canari protège les messages de deux façons, adaptées à deux usages.

| Où | Mécanisme | En mots simples |
| --- | --- | --- |
| Discussions privées et groupes | **MLS** | Chaque conversation a sa propre clé, partagée uniquement par ses participants |
| Salons des communautés | **Graine** | Chaque personne qui écrit dans un salon a sa "graine", une clé de départ qu'elle remet aux autres membres |

Dans l'application, l'écran d'une communauté l'annonce : "Chiffrement E2E actif" ("E2E" veut dire "de
bout en bout" : seuls les deux bouts, vous et vos interlocuteurs, détiennent les clés).

## Ce que le serveur voit, et ce qu'il ne voit pas

**Il ne peut pas lire** : le texte de vos messages, ni le contenu de vos fichiers et photos, qui sont
fermés à clé avant l'envoi.

**Il voit quand même** :

- que vous avez un compte, et dans quelles conversations et communautés vous êtes ;
- qui parle à qui, à quel moment, et la taille approximative de ce qui est envoyé ;
- la liste des membres : c'est le serveur qui décide qui fait partie d'une communauté.

C'est l'équivalent de voir l'enveloppe, son poids et l'heure du dépôt, sans pouvoir l'ouvrir.

## Pourquoi un nouveau téléphone attend parfois son historique

Prenons Léa, qui change de téléphone et se connecte à Canari.

1. Son nouveau téléphone **n'a aucune clé** : elle ne peut rien lire de ce qui a été écrit avant.
2. Le serveur ne peut pas lui donner les anciens messages "en clair" : il ne les a jamais lus.
3. Les anciens messages doivent donc lui être **renvoyés par un autre appareil qui les possède** : son
   ancien téléphone, ou celui d'un participant de la conversation, **à condition qu'il soit connecté
   à ce moment-là**.

C'est pourquoi vous pouvez voir "Réception des messages en attente…" ou, en remontant une
conversation, "Recherche de messages plus anciens…". Si personne ne peut répondre sur le moment,
l'application affiche : "Aucun appareil n'est connecté pour fournir les messages plus anciens.
Réessayez plus tard." Ce n'est pas une panne : il faut qu'un appareil détenant ces messages se
connecte. Ouvrir Canari quelques minutes sur votre ancien téléphone aide souvent.

Le serveur ne garde pas pour autant un exemplaire lisible de tout : **les appareils sont les archives
de vos discussions privées**.

## Les communautés : la "graine" et l'historique

Dans un salon de communauté, c'est un peu différent, parce que les messages y sont conservés sur le
serveur (toujours fermés à clé) et qu'il serait absurde d'obliger quelqu'un à les rejouer un par un.

- Chaque membre qui écrit a une **graine** : une clé de départ dont découlent les clés de tous ses
  messages.
- Quand vous rejoignez la communauté, les membres vous remettent les graines nécessaires, **selon le
  réglage "Historique pour les nouveaux membres"** :
  - "Partagé - les nouveaux membres lisent le passé" ;
  - "À partir de l'arrivée - rien de plus ancien" : les messages d'avant votre arrivée "resteront
    illisibles pour lui, définitivement" (c'est le texte de l'écran, qui parle du nouveau membre).
- Si votre appareil découvre un message dont il lui manque la graine, il **la réclame** à la personne
  qui l'a écrite, ou à un membre en ligne. Le message apparaît dès que la graine arrive. Si personne
  n'est connecté, la demande attend.

**Deux choses à savoir, honnêtement :**

- Ce réglage d'historique est **appliqué par les membres, pas par le serveur** (l'écran le dit : "le
  serveur ne détient aucune clé"). Il est fiable entre personnes honnêtes, mais il ne peut pas
  empêcher une personne malveillante qui a déjà les clés de les redonner.
- Avec le mode "Partagé", **un lien d'invitation qui fuite donne aussi accès au passé**. C'est
  pourquoi l'écran conseille de garder le lien "limité dans le temps et en nombre d'usages".

Et la règle générale, vraie pour toute messagerie : "pouvoir relire le passé" et "le passé devient
illisible pour toujours" ne peuvent pas être vrais en même temps.

## Salons publics, salons privés

- **Tous les membres d'une communauté** détiennent les clés des salons publics de cette communauté.
  C'est voulu : le public d'un salon public, c'est la communauté.
- Un **salon privé** a son propre groupe de clés, limité à ses membres. Les clés ne sont tout
  simplement jamais remises aux autres.
- Un administrateur n'a pas de passe-droit invisible : pour entrer dans un salon privé, il doit le
  **rejoindre**, et il apparaît alors dans la liste des membres. Il lit alors le passé du salon,
  comme n'importe quel membre invité.

## À quoi sert le PIN

Au premier lancement, Canari vous demande de "Choisir un PIN de chiffrement". **Le PIN protège les
clés et les messages enregistrés sur votre appareil**. Pour reprendre l'application : "Entrez votre
PIN pour déverrouiller vos messages."

Ce qu'il faut retenir, et l'écran le dit aussi :

- Le PIN n'est **"jamais stocké sur nos serveurs"**. Personne ne peut vous le redonner, pas même
  l'équipe de Canari. **Notez-le.**
- Si vous l'oubliez, la seule issue est "Réinitialiser mon PIN". Cela "conserve votre compte, vos
  publications et la communauté, mais efface définitivement l'historique de vos messages chiffrés".
  Vous êtes ensuite ré-invité à vos conversations.
- Si vous changez votre PIN sur un appareil, vos **autres appareils devront se reconnecter** avec le
  nouveau PIN. Sur un autre appareil, l'écran propose alors "Mon PIN a changé sur un autre appareil
  → Récupérer mes messages" : vous saisissez l'ancien PIN de cet appareil puis le nouveau, et rien
  n'est perdu.
- L'option "Rester connecté sur cet appareil" garde une copie chiffrée de la clé pour ne pas
  ressaisir le PIN : **à réserver à un appareil personnel**.

## "Un appareil est révoqué" : ce que cela veut dire

Chaque téléphone, tablette ou navigateur connecté à votre compte est un **appareil**. Vous les voyez
dans le profil, sous "Gestion des appareils" ("Chaque ligne est un appareil relié à votre compte").

Quand vous choisissez "Supprimer l'appareil" (on dit aussi **révoquer** un appareil) :

- il est **déconnecté** de votre compte ;
- il **ne peut plus déchiffrer vos conversations** ;
- ses messages en attente sont perdus ;
- s'il se reconnecte un jour, **il repart de zéro**, comme un téléphone neuf.

Garde-fous : Canari refuse de supprimer votre **dernier** appareil (vous perdriez l'accès à vos
conversations chiffrées), et votre compte a une limite du nombre d'appareils : au-delà, il faut en
supprimer un inutilisé avant d'en enregistrer un nouveau.

## Vous perdez ou on vous vole un téléphone

1. Depuis un autre appareil (ou le site web), ouvrez "Gestion des appareils" et **supprimez l'appareil
   perdu**. Il est coupé de votre compte. Si une ligne "connexion" que vous ne reconnaissez pas
   apparaît, supprimez-la aussi.
2. Ce que le voleur pourrait lire, c'est ce qui est **déjà enregistré sur le téléphone**, et la
   protection de cela est le **PIN** (et la biométrie, si vous l'avez activée). Un PIN trop évident
   affaiblit cette protection ; "Rester connecté" la rend plus dépendante du verrouillage de
   l'écran du téléphone.
3. Si vous aviez un seul appareil et l'avez perdu, vos anciens messages ne peuvent pas être
   reconstitués par le serveur. Une nouvelle connexion repart de zéro pour ce qui n'existe plus
   ailleurs.

## Quand vous quittez une conversation ou une communauté

Les écrans demandent confirmation : "Quitter la communauté", "Quitter le canal", "Quitter ce
groupe ?". Concrètement :

- **Vous gardez ce que vous pouviez déjà lire**. Une clé que vous avez reçue ne peut pas être
  "reprise" à distance.
- **Vous ne recevez rien de ce qui est dit après votre départ** : vos accès sont coupés tout de
  suite, et les membres restants passent à de nouvelles clés dont vous ne faites plus partie.
- Si vous revenez plus tard, vous êtes de nouveau un nouveau membre, et l'historique que vous
  retrouvez dépend du réglage de la communauté.

## Combien de temps les messages de salon sont-ils gardés

Les messages des salons de communauté sont supprimés du serveur après **un an**. Les messages
**épinglés** ne sont pas concernés.

## Ce qu'il faut retenir

- Le serveur **ne lit pas** vos messages, mais **voit qui parle à qui, quand, et combien**.
- Un nouvel appareil récupère l'historique **auprès d'autres appareils connectés** : prévoyez un peu
  d'attente, et ayez un appareil en ligne si possible.
- Le **PIN** ne peut pas être retrouvé : notez-le.
- Dans une communauté, **toute personne qui a les clés peut lire le passé qu'elles couvrent** :
  invitez avec soin.
- Supprimer un appareil le coupe immédiatement ; quitter une conversation vous coupe de la suite,
  pas du passé que vous aviez déjà reçu.
