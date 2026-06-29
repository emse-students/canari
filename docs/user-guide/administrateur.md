# Guide administrateur plateforme

> Pour les administrateurs globaux de la plateforme Canari (equipe technique EMSE).

---

## Acces au panneau d'administration

Le panneau d'administration est accessible sur `/admin`. Il est visible uniquement aux
comptes marques **"Global Admin"**.

Pour qu'un utilisateur devienne administrateur global :
1. Rendez-vous sur `/admin/users`.
2. Trouvez l'utilisateur dans la liste.
3. Activez le commutateur **"Administrateur"**.

> Un administrateur ne peut pas revoquer son propre statut d'admin depuis l'interface.

---

## 1. Dashboard (`/admin`)

Vue d'ensemble de la plateforme : liens rapides vers les sections de configuration.

---

## 2. Configuration de la plateforme (`/admin/platform`)

### Mode maintenance

Active une page de maintenance pour tous les utilisateurs non-admins.

| Parametre | Description |
|---|---|
| **Activer la maintenance** | Affiche une page de blocage a tous les utilisateurs (sauf admins) |
| **Message de maintenance** | Texte affiche sur la page de maintenance |

**Quand l'utiliser** : lors d'une migration de base de donnees, d'une mise a jour critique
ou d'une intervention sur les services backend.

### Version minimale du client

| Parametre | Description |
|---|---|
| **Version minimale** | Version semver minimale (ex: `1.2.0`) |

Si un utilisateur ouvre l'app avec une version inferieure, il voit une invite de mise a jour
et ne peut pas continuer. Laissez vide ou `0.0.0` pour desactiver le controle.

**Quand l'utiliser** : apres un changement de protocole incompatible ascendant (MLS, API).

---

## 3. Moderation (`/admin/moderation`)

### File de signalements

Les utilisateurs peuvent signaler des publications inappropriees. Les signalements apparaissent
ici avec :

- L'utilisateur ayant signale le contenu.
- La raison du signalement.
- La publication concernee (avec son contenu).

### Actions disponibles

| Action | Effet |
|---|---|
| **Supprimer la publication** | Retire definitivement la publication pour tous |
| **Ignorer le signalement** | Marque le signalement comme traite, la publication est conservee |

---

## 4. Gestion des utilisateurs (`/admin/users`)

Liste tous les utilisateurs inscrits sur la plateforme.

| Action | Comment faire |
|---|---|
| Rechercher un utilisateur | Barre de recherche en haut de la liste |
| Accorder les droits admin | Activer le commutateur "Administrateur" sur la ligne de l'utilisateur |
| Revoquer les droits admin | Desactiver le commutateur (impossible sur son propre compte) |

---

## 5. Operations courantes

### Ajouter un utilisateur non-ICM

Les utilisateurs externes (non inscrits a l'EMSE) n'ont pas de compte Authentik automatique.
Pour les ajouter :

1. Connectez-vous au panneau d'administration **Authentik** (SSO EMSE).
2. Creez un utilisateur manuel avec une adresse email.
3. Assignez le groupe "canari-users" (ou equivalent selon la configuration).
4. L'utilisateur recoit un email d'invitation pour definir son mot de passe.
5. Il peut ensuite se connecter a Canari normalement.

### Mettre a jour les images Docker (deploiement)

```bash
# Sur le serveur de production
make production
# Equivalent a : docker compose pull && docker compose up -d
```

Voir `infrastructure/MIGRATION.md` pour les procedures completes de deploiement et de
configuration d'un nouveau serveur.

### Vider les bases de donnees (reset dev/staging)

```bash
make reset-services
# Arrete, purge les volumes, redemarre tous les services
```

**Ne jamais executer en production** sans sauvegarde prealable.

### Lancer une sauvegarde manuelle

```bash
# Sur le serveur de production
sudo /etc/cron.daily/canari-backup
```

Les sauvegardes automatiques s'executent quotidiennement a 03h30.
Voir `docs/wiki/infrastructure/backup.md` pour la procedure complete.

---

## 6. Surveillance et logs

| Outil | Acces |
|---|---|
| Logs Docker | `docker compose logs -f [service]` sur le serveur |
| Healthcheck chat-delivery | `GET /api/chat-delivery-health` (pas d'auth requise) |
| MinIO Console | http://[serveur]:9001 (en dev : http://localhost:9001) |

---

## 7. References techniques

| Document | Contenu |
|---|---|
| [`docs/wiki/architecture.md`](../wiki/architecture.md) | Topologie complete, Nginx, auth |
| [`docs/wiki/api-surface.md`](../wiki/api-surface.md) | Tous les endpoints |
| [`docs/AUDIT-MLS-2026-06.md`](../AUDIT-MLS-2026-06.md) | Audit securite MLS en cours |
| [`docs/MLS_RECOVERY_LADDER.md`](../MLS_RECOVERY_LADDER.md) | Procedure de recovery MLS |
| [`infrastructure/MIGRATION.md`](../../infrastructure/MIGRATION.md) | Bootstrap serveur |
