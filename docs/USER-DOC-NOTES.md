# Notes pour la documentation utilisateur (scratch)

> Fichier de travail - FR. Sert de base pour les docs DU1-DU3.
> Format retenu (DU4) : `docs/user-guide/` avec des fichiers Markdown FR,
> une doc par role. A terme, ces fichiers pourront etre rendus dans l'app
> ou exporter en PDF selon besoin.

## Format retenu (DU4)

Markdown FR dans `docs/user-guide/` :
- `docs/user-guide/index.md` — index et presentation generale
- `docs/user-guide/membre.md` — utilisateur standard (DU1)
- `docs/user-guide/responsable-association.md` — responsables (DU2)
- `docs/user-guide/administrateur.md` — admins plateforme (DU3)

## Points a verifier / a illustrer lors de la redaction finale

- **Connexion ICM vs non-ICM** : le parcours de creation de compte differe.
  ICM = SSO Authentik via l'EMSE (identifiants EMSE). Non-ICM = compte
  Authentik independant cree par un admin. A clarifier avec l'equipe EMSE.
- **PIN** : decider quoi dire aux utilisateurs (securite locale, jamais envoye au serveur).
  La formulation actuelle "code secret" est bonne ; insister sur "si vous perdez votre PIN,
  vos messages ne sont pas recuperables sur ce compte/appareil".
- **Multi-appareils** : si un utilisateur se connecte sur un second appareil, il recoit les
  messages futurs mais pas l'historique (forward secrecy MLS). A mentionner dans DU1.
- **Channels vs conversations** : expliquer la distinction (conversation privee E2E vs channel
  de communaute avec chiffrement symetrique par workspace).
- **Paiement Stripe** : l'utilisateur n'a pas besoin de compte Stripe. Il peut payer par carte
  bancaire ou en especes (validation manuelle par le responsable).
- **Supprimer un message** : le message disparait pour tous. L'edit est aussi propagee a tous.
- **Push notifications** : disponibles sur mobile (Android/iOS via FCM/APNs). Sur desktop,
  les notifications systeme sont actives via Tauri.
- **Moderation** : tout utilisateur peut signaler un post. Les admins voient la file de moderation.

## Observations UX a remonter

- Le PIN est demande a chaque reinstallation / changement d'appareil. Prevoir une FAQ.
- Les formulaires avec paiement necessite que l'association ait configure Stripe Connect.
  Sinon, seul le paiement en especes est disponible.
- L'export ICS du calendrier permet d'integrer les evenements dans Google Calendar/Outlook.
