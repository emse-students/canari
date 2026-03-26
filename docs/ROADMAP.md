# Roadmap Globale Canari

Ce document rassemble les différentes feuilles de route (roadmaps) des sous-systèmes de l'application Canari.

## 1. Interface Utilisateur (UI Messages)

### ✅ Phase 1: MVP Messages (Complété)
- [x] Rendu Markdown basique (gras, italique, code).
- [x] Bulles de chat avec styles distincts (expéditeur/destinataire).
- [x] Liste de conversations basique.

### 🟡 Phase 2: Amélioration Expérience (En cours)
- [ ] **Défilement Infini (Infinite Scroll) :** Charger les anciens messages au scroll.
- [ ] **Indicateurs de lecture (Read Receipts) :** Intégration avec les events WebSocket.
- [ ] **Indicateurs de frappe (Typing Indicators) :** WebSocket event \	yping.start\ / \	yping.stop\.
- [ ] **Affichage des Médias :** Miniatures d'images/vidéos intégrées dans les bulles.

### 🔴 Phase 3: Fonctionnalités Avancées (Prévu)
- [ ] **Citations (Replies) :** Répondre à un message spécifique (UI + modèle de données).
- [ ] **Réactions (Emojis) :** Ajouter/retirer des réactions sur un message.
- [ ] **Messages Vocaux :** Enregistrement et lecteur inline.

---

## 2. Canaux Communautaires (Channels)

### ✅ Phase 1: MVP Channels (Intégré dans Social Service)
- [x] Espaces (workspaces) pour promotions / associations.
- [x] Canaux texte avec gestion des rôles et permissions (ACL).
- [x] Chiffrement applicatif soft (pas MLS pur) avec historique lisible pour les nouveaux membres.

### 🟡 Phase 2: Productivité
- [ ] **Fils de discussion (Threads) :** Sous-conversations pour désengorger le canal principal.
- [ ] **Recherche Plein Texte :** Côté client (en raison du chiffrement).
- [ ] **Épinglage (Pins) :** Messages épinglés par les administrateurs.
- [ ] **Invitations par lien :** Rejoindre un espace via URL sécurisée.

### 🔴 Phase 3: Modération et Webhooks
- [ ] **Outils de Modération Avancés :** Mute, Slowmode, Audit Logs (chiffrés).
- [ ] **Webhooks :** Intégration de bots internes.

---

## 3. Synchronisation QR Multi-Appareils

**Objectif :** Permettre de synchroniser l'affichage complet (et le graphe MLS si pertinent via Add/Welcome) entre le téléphone et le PC, de manière sécurisée en réseau local ou par tunnel, via un QR Code.

### 🟡 Phase 1: Session QR Ephemère
- [x] Endpoint \POST /mls-api/sync/session/start\ (créer session QR).
- [x] Endpoint \POST /mls-api/sync/session/join\ (valider par le device 2).
- [ ] **Interface QR :** Affichage front du QR de synchro.
- [ ] **Transport des secrets :** Échange des historiques via WebSocket E2EE.

### 🔴 Phase 2: Continuité d'Identité MLS
- [ ] Export sécurisé de l'état MLS chiffré depuis le téléphone vers l'ordinateur.
- [ ] Fusion de l'identité : les deux appareils agissent sous le même _credential_ MLS ou sont des clients distincts d'un même groupe (approche MLS standard = clients distincts).
