# Social Service

Ce microservice NestJS gère les fonctionnalités "sociales" de Canari. Il regroupe trois domaines principaux : les **Publications (Posts)**, les **Formulaires (Forms)**, et les **Canaux Communautaires (Channels)**.

Il tourne sur le port **3014**.

## 1. Canaux Communautaires (Channels)
Gère les espaces de discussion asynchrones (workspaces/promos) avec une gestion avancée des rôles et des permissions (ACL).

**Fonctionnalités :**
- Mode permissions-first : join, leave, kick.
- Chiffrement applicatif soft (AES-256-GCM, clé dérivée). L'historique des canaux est visible pour les nouveaux membres.
- Les contenus des messages sont chiffrés/déchiffrés côté service (pas de pure E2EE MLS comme les DMs).

## 2. Formulaires (Forms)
Gère la création, la validation, le paiement et l'exportation des formulaires dynamiques. Souvent rattachés à des posts.

**Fonctionnalités :**
- Constructeur dynamique (Texte, Choix multiples, etc.) avec modificateurs de prix.
- Intégration Stripe pour les paiements (ex: billetteries, goodies).
- Export des données au format Excel.

## 3. Publications (Posts)
Gère le fil d'actualité. Les posts peuvent inclure :
- Du texte (Markdown)
- Des médias
- Des sondages (Polls)
- Des événements avec formulaires attachés.

## Lancement
```bash
cd apps/social-service
npm run start:dev
```
