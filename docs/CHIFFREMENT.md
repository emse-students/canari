# Chiffrement

La messagerie utilise un chiffrement de bout en bout (E2EE) pour garantir la confidentialité des messages dans toutes les conversations. Voici les détails techniques des mécanismes de chiffrement utilisés selon le type de discussion :

## 1. Discussions Directes et Petits Groupes (DMs)

- **Protocole de Chiffrement :** Utilisation de **Message Layer Security (MLS)** pour la gestion des clés et le chiffrement de groupe. (cf. [RFC 9420](https://datatracker.ietf.org/doc/html/rfc9420)).
- **Perfect Forward Secrecy (PFS) et Post-Compromise Security (PCS) :** Le protocole MLS assure la rotation continue des clés, empêchant la lecture des anciens messages si une clé est compromise, et garantissant l'impossibilité de lire les nouveaux si un membre est expulsé.

## 2. Canaux Communautaires (Espaces / Workspaces)

Pour les espaces communautaires à fort volume impliquant de fréquents mouvements de membres (ex: promotions, associations), le maintien exclusif de la rotation MLS pure peut s'avérer trop coûteux en performances. Un modèle hybride est ainsi appliqué :

- **Clé par Canal :** Une clé privée symétrique unique (AES-256) est générée pour chaque canal. Actuellement (au stade de MVP), cette clé est statique et n'est pas modifiée au cours du temps.
- **Distribution via MLS :** La clé privée du canal n'est **jamais** transmise en clair au serveur. Lorsqu'un nouveau membre rejoint le canal, un bot ou un administrateur ayant déjà accès transmet la clé privée du canal de manière asynchrone au nouvel arrivant via un message chiffré MLS (en utilisant l'infrastructure sécurisée de la partie DMs/Groupes de l'application).
- **Chiffrement des messages :** Les messages envoyés dans le canal sont chiffrés en AES-256-GCM à l'aide de la clé statique du canal.
- **Accès à l'historique :** Ce paradigme permet intrinsèquement à un nouveau venu, une fois la clé reçue, de déchiffrer sans complexité l'intégralité de l'historique du canal.
- **Gestion des expulsions :** Dans la version actuelle, une exclusion repose sur une interdiction serveur ("soft block") : le serveur coupe l'accès de la cible aux flux de la WebSocket et de l'API. La clé n'étant pas rotative, la cryptographie seule ne prévient pas un membre expulsé de déchiffrer les requêtes futures s'il parvenait à écouter le réseau en contournant l'ACL. C'est un compromis assumé sur ce volet MVP.
