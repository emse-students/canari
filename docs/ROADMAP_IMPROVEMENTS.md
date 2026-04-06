# 🗺️ Roadmap des Améliorations et des Améliorations Futures de Canari

Ce document répertorie les pistes d'amélioration identifiées pour le système de messagerie Canari, en détaillant les étapes de correction ou d'enhancement pour chaque point.

---

## 🚀 I. Amélioration de la Résilience et de la Maintenabilité (Architecture)

L'objectif est de rendre le système plus robuste face aux changements d'infrastructure et aux défaillances partielles.

### 1. Service Discovery pour les Microservices
**Problème identifié** : Les services backend (Delivery, Media, Core, etc.) dépendent de ports fixes (`localhost:3010`, `localhost:3011`, etc.) dans `DEVELOPMENT.md`.
**Objectif** : Remplacer les dépendances de ports fixes par une découverte de services dynamique.
**Étapes de Correction/Enhancement** :
1.  **Implémentation du Registre de Services** : Intégrer un outil de Service Discovery (ex: Consul, ou utiliser les fonctionnalités de Docker Compose en production).
2.  **Mise à jour des Clients** : Modifier les clients (Frontend, Gateway) pour qu'ils interrogent le registre de services au lieu d'utiliser des adresses IP/ports codés en dur.
3.  **Mise à jour des Services** : Chaque service doit s'enregistrer auprès du registre au démarrage et se désenregistrer à l'arrêt.

### 2. Gestion des Erreurs Transversales (Global Exception Handler)
**Problème identifié** : Les gestionnaires d'erreurs sont dispersés (`try/catch` dans `app.controller.ts`, `connection.ts`).
**Objectif** : Uniformiser la gestion des erreurs pour une réponse API/WebSocket cohérente.
**Étapes de Correction/Enhancement** :
1.  **Créer un Handler Global** : Développer un `GlobalExceptionHandler` au niveau du Gateway/API.
2.  **Standardisation des Codes d'Erreur** : Définir un catalogue unique de codes d'erreur (ex: `ERR_MLS_EPOCH_MISMATCH`, `ERR_SESSION_EXPIRED`) et les mapper à des codes HTTP/WebSocket standardisés.
3.  **Implémentation** : Injecter ce handler dans tous les contrôleurs pour qu'il intercepte les exceptions non gérées localement.

---

## 🛡️ II. Amélioration de la Synchronisation et de l'Identité (MLS/Sync)

Ces points visent à perfectionner le cœur de la sécurité et de la continuité de la session.

### 1. Finalisation de la Continuité d'Identité (Roadmap Phase 2)
**Problème identifié** : Le transfert d'état MLS entre appareils (ex: téléphone vers ordinateur) est complexe et doit être parfait.
**Objectif** : Créer un protocole de "Key Transfer Ceremony" explicite.
**Étapes de Correction/Enhancement** :
1.  **Définir le Protocole de Transfert** : Spécifier un flux de messages chiffrés pour transférer l'état MLS (y compris les clés de session et les *ratchet trees*) de manière sécurisée, nécessitant potentiellement une authentification secondaire (ex: PIN/Biométrie sur l'appareil récepteur).
2.  **Implémentation du Backend** : Ajouter un endpoint sécurisé sur le `chat-delivery-service` pour recevoir et valider ce transfert d'état.
3.  **Mise à jour du Frontend** : Mettre à jour `TauriMlsService` et `WebMlsService` pour utiliser ce nouveau flux lors de l'initialisation sur un nouvel appareil.

### 2. Optimisation du Calcul de Diff (Manifest Diff)
**Problème identifié** : La fonction `computeManifestDiff` peut devenir coûteuse avec un grand nombre de conversations.
**Objectif** : Optimiser la comparaison des manifestes de synchronisation.
**Étapes de Correction/Enhancement** :
1.  **Indexation des Manifestes** : Au lieu de comparer les listes complètes, envisager de stocker dans Redis/DB un *checksum* ou un *version number* par conversation (`conversationId`).
2.  **Logique de Diff Réduite** : Le `computeManifestDiff` ne devrait comparer que les manifestes dont le *checksum* ou le *version number* a changé depuis la dernière synchronisation réussie.

---

## 📱 III. Amélioration de l'Expérience Utilisateur (UX/Frontend)

Ces améliorations visent à rendre l'utilisation quotidienne plus fluide.

### 1. Gestion des Notifications et du Focus
**Problème identifié** : Le système de notification est basé sur la présence Redis (`user:online:*`).
**Objectif** : Fournir une expérience utilisateur riche et prédictive.
**Étapes de Correction/Enhancement** :
1.  **Intégration des États de Présence** : Développer une logique pour gérer les états de présence (Ex: "En réunion", "Ne pas déranger") qui doivent impacter la visibilité des notifications et le comportement du *fan-out* de messages.
2.  **Prévisualisation Améliorée** : Améliorer la logique de `buildLinkPreviewPayload` pour gérer des types de contenu plus variés (ex: cartes, documents PDF) au-delà des liens web.

### 2. Amélioration du Flux de Message (Legacy vs MLS)
**Problème identifié** : Le code gère deux chemins de message distincts (`body.proto` pour MLS et `body.content` pour legacy).
**Objectif** : Simplifier le chemin de données pour les développeurs et les mainteneurs.
**Étapes de Correction/Enhancement** :
1.  **Migration Complète** : Définir une date cible pour la décommission de tout chemin "Legacy" (`body.content`/`body.type`).
2.  **Refactoring du `sendMessage`** : Réviser la logique pour que le chemin MLS soit le seul chemin valide, et que le chemin legacy ne soit qu'un *fallback* temporaire avec un avertissement clair.

---

## ✅ Conclusion et Prochaines Étapes

Le projet est extrêmement avancé. Les prochaines étapes devraient se concentrer sur la **maturation de la couche de synchronisation d'identité (MLS)** et la **standardisation de l'infrastructure de communication (Service Discovery)** pour passer d'un environnement de développement complexe à une architecture de production stable.
