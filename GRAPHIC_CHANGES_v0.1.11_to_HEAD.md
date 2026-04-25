# Changements Graphiques depuis v0.1.11

## Vue d'ensemble
Depuis v0.1.11, plusieurs changements majeurs ont affecté l'interface mobile et desktop. Certains ont introduit des bugs d'affichage.

---

## 🔴 Changements MAJEURS

### 1. Restructuration du Layout Principal (Commit: c4190d43 - v0.1.14)
**Fichier**: `frontend/src/routes/+layout.svelte`

#### Changements de Padding et Safe Area
- ❌ **SUPPRESSION** du padding mobile: `pt-[env(safe-area-inset-top)] md:pt-0`
- ❌ **SUPPRESSION** de la hauteur viewport dynamique basée sur la condition auth
- ⚠️ **IMPACT**: Le contenu peut maintenant chevaucher la barre de statut sur mobile

**Ancien code**:
```svelte
<div class="relative flex flex-col {isAuthRoute ? 'min-h-dvh' : 'pt-[env(safe-area-inset-top)] md:pt-0'}"
  style={isAuthRoute ? undefined : `height: var(--app-viewport-height, 100dvh);`}>
```

**Nouveau code**:
```svelte
<div role="presentation" ontouchstart={handleTouchStart} ontouchend={handleTouchEnd}
  class="flex h-[var(--app-viewport-height,100dvh)] w-screen overflow-hidden">
```

#### Restructuration du Flux Flexbox
- 🔄 **Ancien layout**: Imbrication complexe avec `relative z-10 flex flex-1 min-h-0`
- 🔄 **Nouveau layout**: Structure simplifiée en 2 niveaux
  - Niveau 1: `flex h-[100dvh] w-screen overflow-hidden`
  - Niveau 2: `relative flex flex-1 flex-col overflow-hidden`

#### Déplacement du BackgroundBlobs
**Ancien**:
```svelte
<div class="fixed inset-0 z-0 pointer-events-none">
  <BackgroundBlobs />
</div>
```

**Nouveau**:
```svelte
<main class="relative flex-1 overflow-hidden">
  <BackgroundBlobs />
</main>
```

**IMPACT**: 
- BackgroundBlobs passe de `fixed` (superposition fixe) à layout normal
- Z-index change de `z-0` (arrière) à implicite (peut être z-10 du parent)
- Perte de `pointer-events-none` → peut bloquer les interactions si mal positionné

#### Réorganisation de la BottomNav
**Ancien**:
```svelte
{#if !isAuthRoute && !isKeyboardOpen}
  <BottomNav />
{/if}
```

**Nouveau**:
```svelte
{#if !isAuthRoute}
  <BottomNav />
{/if}
```

**IMPACT**: 
- BottomNav s'affiche même quand le clavier est ouvert
- Peut masquer l'input du clavier sur mobile
- ⚠️ **Problème potentiel**: Superposition du clavier et de BottomNav

#### Suppression de LogsPanel Container
**Ancien**:
```svelte
{#if showLogs && !isAuthRoute}
  <div class="fixed inset-0 z-50 flex justify-end pointer-events-none">
    <div class="pointer-events-auto h-full w-full md:w-80">
      <LogsPanel logs={statusLog} onClose={() => (showLogs = false)} />
    </div>
  </div>
{/if}
```

**Nouveau**:
```svelte
{#if showLogs}
  <LogsPanel logs={statusLog} onClose={() => (showLogs = false)} />
{/if}
```

**IMPACT**: Positionnement et z-index potentiellement affectés

---

### 2. Optimisation des Transitions CSS (app.css)
**Problème résolu**: Pression mémoire WebKitGTK lors des transitions de route

**Ancien**:
```css
* {
  transition:
    background-color 180ms ease,
    color 180ms ease,
    border-color 180ms ease;
}
```

**Nouveau**:
```css
/* Theme transitions — scoped to elements that actually change theme colors.
   Avoid `*` selector: it forces WebKitGTK to track animation state for every
   DOM node, causing compositor memory pressure during route transitions. */
:root,
body,
.theme-transition,
nav,
aside,
header,
button,
a,
input,
textarea,
select {
  transition:
    background-color 180ms ease,
    color 180ms ease,
    border-color 180ms ease;
}
```

**IMPACT POSITIF**: Moins de lag lors des changements de thème

---

### 3. Ajout du Fond dans app.html
**Nouveau style ajouté**:
```html
<style>
  html,
  body {
    background: #f9fbff;
  }
</style>
```

**IMPACT**: 
- Fond gris clair défini à la racine du document
- Visible pendant le chargement ou si le contenu n'occupe pas tout l'écran

---

## 🟡 Changements MOYENS

### 4. Gestion Centralisée de l'Authentification
**Fichiers**: `+layout.svelte`, `ChatBackgroundService.svelte`

#### Changements dans ChatBackgroundService
- ❌ Suppression des `goto()` vers `/login` 
- ✅ Logique centralisée dans le layout auth guard

**Ancien** (ChatBackgroundService):
```typescript
const cur = window.location.pathname + window.location.search;
void goto(`/login?returnTo=${encodeURIComponent(cur)}`, { replaceState: true });
```

**Nouveau**:
```typescript
// No saved user — the layout auth guard will redirect to /login.
```

#### Ajout dans +layout.svelte
```typescript
let _authNavigating = false;
$effect(() => {
  if (typeof window === 'undefined') return;
  if (isAuthRoute) {
    return;
  }
  if (!currentUserId()) {
    if (_authNavigating) return;
    _authNavigating = true;
    setTimeout(() => {
      goto(`/login?returnTo=${encodeURIComponent(pathname)}`, { replaceState: true })
        .catch(() => {})
        .finally(() => {
          _authNavigating = false;
        });
    }, 0);
  }
});
```

**IMPACT**: 
- ✅ Évite les redirects multiples (flag `_authNavigating`)
- ✅ Gestion centralisée plus propre
- ⚠️ Délai de 0ms avec `setTimeout()` peut causer un flash d'écran

---

### 5. Ajout de la Page d'Erreur
**Nouveau fichier**: `frontend/src/routes/+error.svelte`

```svelte
<main class="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
  <p class="text-2xl font-bold text-text-main">{page.status}</p>
  <p class="text-text-muted">{page.error?.message ?? 'Une erreur inattendue est survenue.'}</p>
  <button
    class="mt-2 px-4 py-2 rounded-xl bg-cn-yellow text-cn-dark font-semibold text-sm"
    onclick={() => goto('/login', { replaceState: true })}
  >
    Retour à l'accueil
  </button>
</main>
```

**IMPACT**: Meilleure UX pour les erreurs HTTP

---

### 6. Changements de PostImage.svelte
**Fichier**: `frontend/src/lib/components/posts/PostImage.svelte`

#### Changement d'icône
- ❌ `AlertCircle` → ✅ `CircleAlert` (mise à jour lucide-svelte)

#### Ajout de Lightbox pour Tauri
**Ancien**:
```typescript
if ((window as any).__TAURI_INTERNALS__) {
  const win = window.open('', '_blank');
  if (win) {
    win.location.href = blobUrl;
  }
} else {
  window.open(blobUrl, '_blank', 'noopener,noreferrer');
}
```

**Nouveau**:
```typescript
if ((window as any).__TAURI_INTERNALS__) {
  // Tauri: no popup windows — show in-page lightbox instead.
  lightboxOpen = true;
} else {
  window.open(blobUrl, '_blank', 'noopener,noreferrer');
}

function closeLightbox(e: MouseEvent | KeyboardEvent) {
  if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
  lightboxOpen = false;
}
```

**Nouveau DOM**:
```svelte
{#if lightboxOpen && blobUrl}
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Image agrandie"
    tabindex="-1"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
    onclick={closeLightbox}
    onkeydown={closeLightbox}
  >
    <img
      src={blobUrl}
      alt={media.fileName ?? 'Image agrandie'}
      class="max-w-full max-h-full object-contain select-none"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    />
  </div>
{/if}
```

**IMPACT**: 
- ✅ Pas de popup windows sur Tauri
- ✅ Lightbox accessible (ARIA, keyboard)
- ✅ Interface plus cohérente

---

### 7. Mise à jour de LoginPage.svelte
**Changement**: Gestion du service de biométrie

**Ancien**:
```typescript
biometricAvailable = await BiometricService.isConfigured();
```

**Nouveau**:
```typescript
try {
  biometricAvailable = await BiometricService.isAvailable();
} catch {
  biometricAvailable = false;
}
```

**IMPACT**: Meilleure gestion d'erreur

---

## 🟢 Changements MINEURS

### 8. Mise à jour de +page.svelte
- Texte: "Redirection vers les posts..." → "Chargement..."
- Logique: Redirection conditionnelle (login vs posts) basée sur `currentUserId()`

### 9. Suppressions Tauri
**ChatBackgroundService.svelte**: Suppression du listener de notification Tauri
```typescript
// ── Tauri notification click → show & focus window ─────────────────────
// ❌ REMOVED
```

### 10. Thèmes Android Tauri
- Changements mineurs dans les fichiers de couleurs/thèmes Android
- Ajout de variables de couleur pour la nuit

---

## 📋 Résumé des Problèmes Identifiés

### 🔴 Mobile (Interface cassée)
1. **Padding Top perdu**: Suppression de `pt-[env(safe-area-inset-top)]`
   - Contenu peut chevaucher la barre de statut
   
2. **BottomNav toujours visible**
   - Clavier potentiellement masqué quand une BottomNav s'affiche

3. **BackgroundBlobs repositionné**
   - Perte de `pointer-events-none`, peut bloquer interactions

### 🟡 Desktop
1. **Overflow et scroll potentiellement affectés**
   - Changement de `overflow-y-auto` à `overflow-hidden`
   
2. **Z-index potentiellement problématique**
   - Perte de `z-10` sur la zone principale
   - BackgroundBlobs dans le flux normal au lieu de fixed

3. **LogsPanel sans container fixed**
   - Positionnement potentiellement brisé

---

## 🔧 Commits Clés

| Commit | Date | Description |
|--------|------|-------------|
| `c4190d43` | ? | **Restructuration majeure du layout** - v0.1.14 |
| `5ce140c5` | 22 avr 2026 | Thèmes Tauri Android + page erreur |
| `6bc267f3` | 24 avr 2026 | Initialisation fenêtre mobile + gestion cookies |
| `83cacbda` | ? | Bump version v0.1.22 |

---

## ✅ Recommandations

1. **Restaurer le padding mobile**: Remettre `pt-[env(safe-area-inset-top)]` en conditions
2. **Revoir BottomNav**: Ajouter la condition `!isKeyboardOpen` ou utiliser `position: sticky`
3. **BackgroundBlobs**: Remettre en `fixed` et restaurer `pointer-events-none`
4. **Overflow**: Vérifier le comportement du scroll avec les nouvelles classes
5. **Z-index**: Mapper les z-index de manière explicite et cohérente
