# Garde-fous anti-fuite d'IDs — Checklist Code Review

> **Règle d'or :** Les IDs ne doivent JAMAIS apparaître dans l'interface utilisateur. Toute fonction qui prend un ID en entrée et retourne un string affichable doit garantir qu'elle ne retourne jamais l'ID brut.

---

## Checklist Code Review

Avant d'approuver toute PR touchant à l'affichage de données utilisateur, vérifier :

### Affichage des noms

- [ ] Aucun appel à `.slice()` sur une variable contenant `Id` dans le template (ex : `userId.slice(0, 8)`)
- [ ] Aucun appel à `getUserDisplayNameSync(x, x)` — le fallback ne doit jamais être l'ID lui-même
- [ ] Aucun affichage direct de `userId`, `deviceId`, `groupId`, `senderId` dans du HTML/Svelte

### Fonctions retournant des strings affichables

- [ ] Toute nouvelle fonction retournant un string affichable ne retourne jamais un ID brut
- [ ] Les fonctions de résolution de nom utilisent `m.user_unknown_label()` comme dernier recours (pas l'ID)
- [ ] `getUserInitials()` ne retourne jamais le premier caractère d'un ID

### API

- [ ] Les nouveaux endpoints API exposent `displayName` plutôt que `userId` quand c'est destiné à l'affichage
- [ ] Les DTOs de réponse ne contiennent pas de champs internes inutiles (`keyPackage`, `recipientId`, `deviceId`)
- [ ] Les endpoints qui retournent des listes d'utilisateurs résolvent les noms côté serveur (batch SQL)

### Exceptions légitimes (admin uniquement)

- [ ] L'affichage d'un ID brut est derrière un check `isGlobalAdmin` explicite
- [ ] Le mode debug admin est clairement identifié visuellement (pas d'IDs dans l'UI standard)

---

## Détection automatique

```bash
# Détecter les IDs tronqués dans les templates Svelte
git grep '\.slice(0,' -- '*.svelte'

# Détecter les IDs utilisés comme leur propre fallback
git grep 'getUserDisplayNameSync([^,]*,\s*\1)' -- '*.svelte' '*.ts'
```

> **Note :** Oxlint ne supporte pas les règles custom (linter Rust non-extensible). Ces commandes `git grep` sont cross-platform et peuvent être utilisées en CI/pre-commit pour servir de filet de sécurité.

---

## Patterns à ne JAMAIS utiliser

### ❌ Pattern 1 : ID tronqué

```svelte
<!-- ❌ Interdit -->
{userId.slice(0, 8)}…
{deviceId.slice(0, 24)}

<!-- ✅ Correct -->
{getUserDisplayNameSync(userId)}
{device.deviceName || m.user_unknown_label()}
```

### ❌ Pattern 2 : ID comme fallback de lui-même

```typescript
// ❌ Interdit
getUserDisplayNameSync(senderId, senderId)

// ✅ Correct
getUserDisplayNameSync(senderId)
```

### ❌ Pattern 3 : ID brut retourné par une fonction d'affichage

```typescript
// ❌ Interdit
function formatName(profile: { id: string }): string {
  return profile.displayName || profile.id;  // L'ID fuit !
}

// ✅ Correct
function formatName(profile: { id: string }): string {
  return profile.displayName?.trim() || m.user_unknown_label();
}
```

### ❌ Pattern 4 : Initiale extraite de l'ID

```typescript
// ❌ Interdit
const display = (p.displayName?.trim() || p.id || userId).charAt(0).toUpperCase();

// ✅ Correct
const display = (p.displayName?.trim() || '?').charAt(0).toUpperCase();
```

---

## Tests automatisés

Les tests dans [`displayName.spec.ts`](../../frontend/src/lib/utils/users/displayName.spec.ts) garantissent que :

- `getUserDisplayNameSync(userId)` ne retourne jamais l'ID brut
- `getUserInitials(userId)` ne retourne jamais le premier caractère de l'ID
- Le fallback correct (`m.user_unknown_label()`) est toujours utilisé

Lancer les tests :

```bash
cd frontend && npx vitest run src/lib/utils/users/displayName.spec.ts
```
