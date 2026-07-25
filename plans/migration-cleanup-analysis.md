# Rapport d'analyse — Nettoyage des migrations `social-service`

> **Date** : 2026-07-25
> **Périmètre** : `apps/social-service/src/migrations/` (32 fichiers)
> **Méthode** : Analyse croisée entre chaque migration et le code actuel (entités TypeORM, services)
> **Statut** : Analyse et recommandations uniquement — aucune modification effectuée

---

## 1. État des lieux

32 fichiers de migration sont présents. Chaque migration a été comparée aux entités TypeORM actuelles (`@Entity()`), au [`channel.service.ts`](../apps/social-service/src/channels/channel.service.ts) et au document de stratégie [`channel-permissions-redesign.md`](../docs/strategy/channel-permissions-redesign.md).

---

## 2. Analyse détaillée par migration

### Légende

| Symbole | Signification |
|---------|--------------|
| ✅ **GARDER** | Migration pertinente, effet toujours visible dans le code |
| ❌ **SUPPRIMER** | Migration obsolète (rollbackée ou annulée par une migration ultérieure) |
| 🔀 **FUSIONNER** | Migration dont l'effet est annulé par une autre (paire add-then-drop) |
| ⚡ **FUSIONNABLE** | Plusieurs migrations contiguës sur la même table, candidates à la fusion |

---

### 001 — `permissions_bitmask.sql`

| Champ | Valeur |
|-------|--------|
| Tables | `association_members`, `associations` |
| Contenu | Conversion enum → bitmask (`permission` → `permissions` INTEGER), ajout de `is_bde`, `document_vault_key`, `document_quota_bytes` (en **snake_case** ⚠️) sur `associations` |
| Entité actuelle | `AssociationMember.permissions` (INTEGER, bitmask) ✅ — `Association.isBDE`, `documentVaultKey`, `documentQuotaBytes` (camelCase) ✅ |
| Problème | Les colonnes snake_case ajoutées sur `associations` ont été supprimées par la migration 012 (doublons morts) |
| **Verdict** | ✅ **GARDER** — La conversion enum→bitmask reste la fondation du système de permissions des associations. Les lignes `ADD COLUMN` snake_case sont des no-ops idempotents depuis la 012. |

---

### 002 — `form_closed_at.sql`

| Champ | Valeur |
|-------|--------|
| Table | `forms` |
| Contenu | Ajout de `closedAt` |
| Entité actuelle | `Form.closedAt` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 003 — `channels_missing_columns.sql`

| Champ | Valeur |
|-------|--------|
| Tables | `channels`, `channel_workspaces` |
| Contenu | Ajout de `masterSecret`, `imageMediaId`, `allowedUsers` sur `channels` ; `imageMediaId` sur `channel_workspaces` |
| Entité actuelle | `Channel.masterSecret` ✅, `Channel.allowedUsers` ✅, `Workspace.imageMediaId` ✅ — mais `Channel.imageMediaId` **n'existe plus** (supprimé par 023) |
| **Verdict** | 🔀 **FUSIONNER avec 023** — La ligne `ADD COLUMN "imageMediaId"` sur `channels` est annulée par 023. On peut retirer ces 2 lignes de la 003 et supprimer la 023. |

---

### 004 — `manage_stripe_connect.sql`

| Champ | Valeur |
|-------|--------|
| Table | `association_members` |
| Contenu | Data migration : ajout du flag `MANAGE_STRIPE_CONNECT` (bit 512) aux membres éligibles |
| Entité actuelle | `AssociationPermissionFlag.MANAGE_STRIPE_CONNECT = 1 << 9` ✅ |
| **Verdict** | ✅ **GARDER** — Migration de données idempotente, toujours pertinente pour les DB existantes. |

---

### 005 — `allow_multiple_submissions.sql`

| Champ | Valeur |
|-------|--------|
| Table | `forms` |
| Contenu | Ajout de `allowMultipleSubmissions` |
| Entité actuelle | `Form.allowMultipleSubmissions` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 006 — `association_role_history.sql`

| Champ | Valeur |
|-------|--------|
| Table | `association_role_history` (création) |
| Entité actuelle | `AssociationRoleHistory` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 007 — `channel_message_pinned.sql`

| Champ | Valeur |
|-------|--------|
| Table | `channel_messages` |
| Contenu | Ajout de `pinned` |
| Entité actuelle | `ChannelMessage.pinned` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 008 — `associations_lists_and_fields.sql`

| Champ | Valeur |
|-------|--------|
| Table | `associations` |
| Contenu | Ajout de `archived`, `contactEmail`, `type`, `promo`, `parentAssociationId` |
| Entité actuelle | Tous présents dans `Association` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 009 — `content_report_reviewed_at.sql`

| Champ | Valeur |
|-------|--------|
| Table | `content_reports` |
| Contenu | Ajout de `reviewedAt` |
| Entité actuelle | `ContentReport.reviewedAt` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 010 — `workspace_invites.sql`

| Champ | Valeur |
|-------|--------|
| Table | `workspace_invites` (création) |
| Entité actuelle | `WorkspaceInvite` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 011 — `association_notes.sql`

| Champ | Valeur |
|-------|--------|
| Table | `associations` |
| Contenu | Ajout de `notesCiphertext` |
| Entité actuelle | `Association.notesCiphertext` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 012 — `drop_associations_legacy_snake_columns.sql`

| Champ | Valeur |
|-------|--------|
| Table | `associations` |
| Contenu | Suppression des colonnes snake_case `is_bde`, `document_vault_key`, `document_quota_bytes` (doublons créés par la migration 001) |
| Entité actuelle | Les colonnes camelCase (`isBDE`, `documentVaultKey`, `documentQuotaBytes`) sont les seules utilisées ✅ |
| **Verdict** | ✅ **GARDER** — Migration de nettoyage idempotente. |

---

### 013 — `channel_notification_levels.sql`

| Champ | Valeur |
|-------|--------|
| Table | `channel_members` |
| Contenu | Ajout de `notifLevels` (JSONB) |
| Entité actuelle | `ChannelMember.notifLevels` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 014 — `calendar_event_kind.sql`

| Champ | Valeur |
|-------|--------|
| Table | `association_calendar_events` |
| Contenu | Ajout de `kind` |
| Entité actuelle | `AssociationCalendarEvent.kind` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 015 — `list_second_theme.sql`

| Champ | Valeur |
|-------|--------|
| Table | `associations` |
| Contenu | Ajout de `name2`, `logoMediaId2` (listes de promo uniquement) |
| Entité actuelle | `Association.name2`, `Association.logoMediaId2` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 016 — `cotisations.sql`

| Champ | Valeur |
|-------|--------|
| Tables | `association_products`, `associations` |
| Contenu | Ajout de `membersOnly`, `amountCentsMember` sur `association_products` ; `cotisationEnabled`, `cotisationMode`, `cotisationExpiresAt` sur `associations` + backfill |
| Entité actuelle | Tous présents ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 017 — `payment_delegation.sql`

| Champ | Valeur |
|-------|--------|
| Table | `associations` |
| Contenu | Ajout de `paymentParentAssociationId`, `paymentDelegationStatus` |
| Entité actuelle | `Association.paymentParentAssociationId`, `Association.paymentDelegationStatus` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 018 — `minesweeper_leaderboard.sql`

| Champ | Valeur |
|-------|--------|
| Tables | `minesweeper_challenges`, `minesweeper_scores` (création) |
| Entité actuelle | `MinesweeperChallenge`, `MinesweeperScore` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 019 — `association_document_visibility.sql`

| Champ | Valeur |
|-------|--------|
| Table | `association_documents` |
| Contenu | Ajout de `visibility`, `originalFilename` |
| Entité actuelle | `AssociationDocument.visibility`, `AssociationDocument.originalFilename` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 020 — `document_reviewer_grants.sql`

| Champ | Valeur |
|-------|--------|
| Table | `document_reviewer_grants` (création) |
| Entité actuelle | `DocumentReviewerGrant` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 021 — `association_categories.sql`

| Champ | Valeur |
|-------|--------|
| Tables | `association_categories` (création), `associations` (+ `categoryId`) |
| Entité actuelle | `AssociationCategory`, `Association.categoryId` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 022 — `poster_projects.sql`

| Champ | Valeur |
|-------|--------|
| Table | `poster_projects` (création) |
| Entité actuelle | `PosterProject` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 023 — `drop_channel_image.sql`

| Champ | Valeur |
|-------|--------|
| Table | `channels` |
| Contenu | Suppression de `imageMediaId` |
| Entité actuelle | `Channel` ne possède **pas** de colonne `imageMediaId` ✅ |
| **Verdict** | 🔀 **FUSIONNER avec 003** — Si on retire les 2 lignes `ADD COLUMN "imageMediaId"` de la migration 003, cette migration 023 devient inutile et peut être supprimée. |

---

### 024 — `channel_member_sort_order.sql`

| Champ | Valeur |
|-------|--------|
| Table | `channel_members` |
| Contenu | Ajout de `sortOrder` |
| Entité actuelle | `ChannelMember.sortOrder` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 025 — `cotisation_tiers.sql`

| Champ | Valeur |
|-------|--------|
| Table | `association_products` |
| Contenu | Ajout de `variantKey`, `variantLevel` |
| Entité actuelle | `AssociationProduct.variantKey`, `AssociationProduct.variantLevel` ✅ |
| **Verdict** | ⚡ **FUSIONNABLE avec 026 et 027** |

---

### 026 — `cotisation_member_price_tag.sql`

| Champ | Valeur |
|-------|--------|
| Table | `association_products` |
| Contenu | Ajout de `memberPriceTag` |
| Entité actuelle | `AssociationProduct.memberPriceTag` ✅ |
| **Verdict** | ⚡ **FUSIONNABLE avec 025 et 027** |

---

### 027 — `cotisation_required_tags.sql`

| Champ | Valeur |
|-------|--------|
| Table | `association_products` |
| Contenu | Ajout de `requiredTags` |
| Entité actuelle | `AssociationProduct.requiredTags` ✅ |
| **Verdict** | ⚡ **FUSIONNABLE avec 025 et 026** |

---

### 028 — `channel_permission_overrides.sql` ❌

| Champ | Valeur |
|-------|--------|
| Tables | `channel_permission_overrides` (création), `channels` (+ `usePermissionOverrides`) |
| Contenu | Création de la table d'overrides + colonne d'activation sur `channels` |
| Entité actuelle | ❌ Aucune entité `ChannelPermissionOverride` n'existe. ❌ `Channel` n'a pas de colonne `usePermissionOverrides`. |
| Annulée par | Migration 032 qui **DROP** la table et la colonne |
| **Verdict** | ❌ **SUPPRIMER** — Complètement rollbackée. La table et la colonne n'existent plus. |

---

### 029 — `fix_permission_overrides_column.sql` ❌

| Champ | Valeur |
|-------|--------|
| Table | `channels` |
| Contenu | Renomme `use_permission_overrides` (snake_case, créé par erreur) → `usePermissionOverrides` (camelCase) |
| Annulée par | Migration 032 qui **DROP** la colonne |
| **Verdict** | ❌ **SUPPRIMER** — Corrections d'une colonne qui n'existe plus. |

---

### 030 — `update_legacy_channel_permissions.sql`

| Champ | Valeur |
|-------|--------|
| Table | `channel_roles` |
| Contenu | Data migration : remplace les anciennes clés (`MANAGE_WORKSPACE` → `workspace.manage`, etc.) |
| Entité actuelle | `ChannelRole.permissions` avec `@AfterLoad()` qui normalise via `LEGACY_PERMISSION_MAPPING` ✅ |
| **Verdict** | ✅ **GARDER** — Migration de données idempotente. Le `@AfterLoad()` dans l'entité sert de filet de sécurité, mais la migration reste le moyen canonique de nettoyer la DB. |

---

### 031 — `channel_write_policy.sql`

| Champ | Valeur |
|-------|--------|
| Table | `channels` |
| Contenu | Ajout de `writePolicy` |
| Entité actuelle | `Channel.writePolicy` ✅ |
| **Verdict** | ✅ **GARDER** |

---

### 032 — `drop_channel_permission_overrides.sql`

| Champ | Valeur |
|-------|--------|
| Tables | `channel_permission_overrides` (DROP), `channels` (DROP `usePermissionOverrides`) |
| Contenu | Suppression du système d'overrides rollbacké |
| Entité actuelle | ✅ Cohérent : ni la table ni la colonne n'existent |
| **Verdict** | ✅ **GARDER** — Migration de nettoyage ; si on supprime 028 et 029, celle-ci reste nécessaire pour les DB qui ont déjà appliqué 028/029. |

---

## 3. Synthèse visuelle

```
Migration 001 ████████████████████████████████ ✅ GARDER (fondation permissions asso)
Migration 002 ████████████████████████████████ ✅ GARDER
Migration 003 ████████████████████████████████ 🔀 FUSIONNER avec 023
Migration 004 ████████████████████████████████ ✅ GARDER
Migration 005 ████████████████████████████████ ✅ GARDER
Migration 006 ████████████████████████████████ ✅ GARDER
Migration 007 ████████████████████████████████ ✅ GARDER
Migration 008 ████████████████████████████████ ✅ GARDER
Migration 009 ████████████████████████████████ ✅ GARDER
Migration 010 ████████████████████████████████ ✅ GARDER
Migration 011 ████████████████████████████████ ✅ GARDER
Migration 012 ████████████████████████████████ ✅ GARDER
Migration 013 ████████████████████████████████ ✅ GARDER
Migration 014 ████████████████████████████████ ✅ GARDER
Migration 015 ████████████████████████████████ ✅ GARDER
Migration 016 ████████████████████████████████ ✅ GARDER
Migration 017 ████████████████████████████████ ✅ GARDER
Migration 018 ████████████████████████████████ ✅ GARDER
Migration 019 ████████████████████████████████ ✅ GARDER
Migration 020 ████████████████████████████████ ✅ GARDER
Migration 021 ████████████████████████████████ ✅ GARDER
Migration 022 ████████████████████████████████ ✅ GARDER
Migration 023 ████████████████████████████████ 🔀 FUSIONNER avec 003
Migration 024 ████████████████████████████████ ✅ GARDER
Migration 025 ██ ⚡ FUSIONNABLE (cotisation_products)
Migration 026 ██ ⚡ FUSIONNABLE (cotisation_products)
Migration 027 ██ ⚡ FUSIONNABLE (cotisation_products)
Migration 028 ██ ❌ SUPPRIMER (rollbackée par 032)
Migration 029 ██ ❌ SUPPRIMER (rollbackée par 032)
Migration 030 ████████████████████████████████ ✅ GARDER
Migration 031 ████████████████████████████████ ✅ GARDER
Migration 032 ████████████████████████████████ ✅ GARDER
```

---

## 4. Plan de nettoyage recommandé

### 4.1 Actions prioritaires (sans risque)

| Action | Fichiers concernés | Justification |
|--------|-------------------|---------------|
| **Supprimer** | `028_channel_permission_overrides.sql` | Table + colonne droppées par 032. Aucune entité correspondante. |
| **Supprimer** | `029_fix_permission_overrides_column.sql` | Corrigeait une colonne qui n'existe plus (dropée par 032). |

Ces deux suppressions sont **sans risque** : elles concernent une fonctionnalité (`ChannelPermissionOverride`) qui a été entièrement rollbackée. La migration 032 reste en place pour nettoyer les DB qui auraient déjà appliqué 028/029.

### 4.2 Fusions recommandées

| Fusion | Fichiers concernés | Description |
|--------|-------------------|-------------|
| **Add-then-drop** | `003` + `023` | Retirer les 2 lignes `ALTER TABLE channels ADD COLUMN IF NOT EXISTS "imageMediaId"` de 003. Supprimer 023. |
| **Cotisation products** | `025` + `026` + `027` | Fusionner en une seule migration `025_cotisation_products.sql` qui ajoute `variantKey`, `variantLevel`, `memberPriceTag`, `requiredTags` en une seule transaction. |

### 4.3 Résultat après nettoyage

```
Avant : 32 fichiers
Après : 27 fichiers (suppression de 028, 029 ; fusion de 003+023 ; fusion de 025+026+027)
Soit   : 32 - 2 - 1 - 2 = 27 fichiers
```

Numérotation après fusion (si on renumérote) :

| Ancien | Nouveau | Nom |
|--------|---------|-----|
| 001 | 001 | `permissions_bitmask.sql` |
| 002 | 002 | `form_closed_at.sql` |
| 003 | 003 | `channels_missing_columns.sql` (modifié : sans `imageMediaId`) |
| 004 | 004 | `manage_stripe_connect.sql` |
| ... | ... | ... |
| 023 | — | `drop_channel_image.sql` (**supprimé**, intégré dans 003) |
| 024 | 022 | `channel_member_sort_order.sql` |
| 025+026+027 | 023 | `cotisation_products.sql` (fusionné) |
| 028 | — | **supprimé** |
| 029 | — | **supprimé** |
| 030 | 024 | `update_legacy_channel_permissions.sql` |
| 031 | 025 | `channel_write_policy.sql` |
| 032 | 026 | `drop_channel_permission_overrides.sql` |

### 4.4 Option alternative : ne pas renuméroter

Si la renumérotation est jugée trop risquée (références dans des tickets, logs, etc.), on peut simplement :
- Supprimer les fichiers 028 et 029
- Laisser un trou dans la numérotation
- Fusionner 025+026+027 en conservant le numéro 025

---

## 5. Vérification en production

> ⚠️ **Non effectuée** — L'accès au serveur de production est nécessaire pour :
> 1. Vérifier que la table `channel_permission_overrides` n'existe plus (`\dt channel_permission_overrides`)
> 2. Vérifier que la colonne `usePermissionOverrides` n'existe plus sur `channels`
> 3. Vérifier que la colonne `imageMediaId` n'existe plus sur `channels`
> 4. Vérifier que les migrations ont bien toutes été appliquées (`SELECT * FROM migrations`)

Commande suggérée pour vérifier l'état en production :
```bash
ssh canari-prod
docker exec -it canari-postgres psql -U canari -d canari -c "
SELECT table_name FROM information_schema.tables WHERE table_name = 'channel_permission_overrides';
SELECT column_name FROM information_schema.columns WHERE table_name = 'channels' AND column_name IN ('imageMediaId', 'usePermissionOverrides');
"
```

---

## 6. Conclusion

Le dossier de migrations est globalement sain. Sur 32 fichiers :

- **2 sont à supprimer** (028, 029) car complètement rollbackés par 032
- **1 paire est à fusionner** (003 + 023) car add-then-drop
- **1 triplet est fusionnable** (025 + 026 + 027) car colonnes contiguës sur la même table
- **27 migrations restent pertinentes** et correspondent au code actuel

Le nettoyage recommandé est conservateur et sans risque : on ne supprime que ce qui est objectivement mort, et on fusionne ce qui est redondant.
