# Core Service

Ce microservice NestJS gère l'authentification (Auth) et les profils utilisateurs (Users) de Canari.
Il gère également une partie des vérifications de paiement Stripe en lien avec social-service.

Il tourne sur le port **3012**.

## Fonctionnalités Clés
- Enregistrement / Connexion des utilisateurs
- PKCE / MFA (à venir)
- Profil public (Avatar, Display Name)
- Fourniture des clés d'identité (Key Packages initiaux)

## Lancement
```bash
cd apps/core-service
npm run start:dev
```
