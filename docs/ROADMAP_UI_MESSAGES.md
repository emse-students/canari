# Roadmap UI/UX et Architecture Messages

## Contexte
Suite à l'implémentation complète du système média (étapes 1-4), voici les améliorations restantes pour l'interface utilisateur et l'architecture des messages.

## ✅ Terminé (Étapes 1-4)

### 1. Affichage médias amélioré
- ✅ Support audio avec lecteur natif
- ✅ Images agrandies (max 80vh vs 64px)
- ✅ Vidéos avec player natif (max 80vh)
- ✅ Fichiers avec icône, nom, taille, bouton téléchargement

### 2. Enregistrement vocal
- ✅ Composant VoiceRecorder.svelte
- ✅ MediaRecorder API (WebM/Opus)
- ✅ Interface d'enregistrement (durée, stop, annuler)
- ✅ Envoi automatique après enregistrement

### 3. Compression images/vidéos
- ✅ Fonction `compressImage()` dans media.ts
- ✅ Compression automatique avant upload (canvas resize)
- ✅ Limite résolution 1920x1080, qualité WebP 85%
- ✅ Logs compression (taille avant/après)

### 4. Picker GIF
- ✅ Composant GifPicker.svelte
- ✅ Intégration Tenor API (clé configurable `VITE_TENOR_API_KEY`)
- ✅ Recherche + GIFs tendances
- ✅ Téléchargement et envoi comme image chiffrée

### 5. Réactions réactives
- ✅ Fix réactivité SvelteMap → Record dérivé
- ✅ `reactionsForProps` dans MainChatPage.svelte
- ✅ Support Record | Map dans ChatArea.svelte

---

## 🔄 À Implémenter (Étapes 6-10)

### 6. Confirmations de réception et de lecture (Read Receipts)

**Problématique:**
- Actuellement aucune indication si un message estdélivré/lu
- Nécessite tracking côté serveur et messages système

**Solution proposée:**
```typescript
// Nouveau type de message JSON
{
  "type": "read_receipt",
  "messageId": "uuid-du-message-lu",
  "status": "delivered" | "read",
  "timestamp": number
}
```

**Modifications requises:**
1. **chat-delivery-service**: Stocker état delivery/read par message/user
2. **chat-gateway**: Relayer read receipts
3. **MainChatPage**: Tracker messages vus (IntersectionObserver?)
4. **MessageBubble**: Afficher icônes état (✓✓ reçu, ✓✓bleu lu)

**Fichiers à modifier:**
- `apps/chat-delivery-service/src/message.schema.ts` (ajouter ReadReceipt)
- `frontend/src/lib/types.ts` (DeliveryStatus, ReadStatus)
- `frontend/src/lib/utils/mainChatConnection.ts` (handler read_receipt)
- `frontend/src/lib/components/MessageBubble.svelte` (UI status)

---

### 7. Suppression et modification de messages

**Problématique:**
- Messages immutables actuellement
- Besoin de "soft delete" et édition avec historique

**Solution proposée:**
```typescript
// Message de suppression
{
  "type": "delete",
  "messageId": "uuid-du-message-a-supprimer",
  "timestamp": number
}

// Message d'édition
{
  "type": "edit",
  "messageId": "uuid-du-message-a-editer",
  "newContent": "Nouveau contenu (ou MediaRef JSON)",
  "editedAt": number
}
```

**Modifications requises:**
1. **chat-delivery-service**: Marquer messages comme deleted/edited
2. **MainChatPage**: Ajouter actions edit/delete dans MessageBubble
3. **MessageBubble**: Afficher état "supprimé" / "édité"
4. **ChatComposer**: Mode édition (pre-fill textarea)

**UI:**
- Clic droit / long press pour menu contextuel (éditer/supprimer)
- Messages supprimés : afficher "Message supprimé" en gris
- Messages édités : afficher "(édité)" + timestamp

**Fichiers à modifier:**
- `frontend/src/lib/components/MessageBubble.svelte` (menu contextuel)
- `frontend/src/lib/components/ChatComposer.svelte` (mode édition)
- `frontend/src/lib/utils/mainChatMessaging.ts` (sendDeleteMessage, sendEditMessage)
- `frontend/src/lib/utils/mainChatConnection.ts` (handler delete/edit)

---

### 8. Migration vers JSON pour tous les messages

**Problématique:**
- Messages texte actuellement en string brut
- Messages média, réponses, réactions déjà en JSON
- Besoin d'unifier le format pour futures métadonnées

**Solution proposée:**
```typescript
// Nouveau format unifié
{
  "type": "text",
  "content": "Message texte ici",
  "timestamp": number,
  // Optionnel:
  "replyTo"?: string,  // messageId
  "mentions"?: string[], // userIds
  "formatting"?: { bold?: [number, number][], italic?: ... }
}
```

**Migration:**
- Parser messages legacy (string sans `{`) comme `{type: "text", content:  ...}`
- `parseMediaMessage()` devient `parseMessage()` générique
- Retro-compatibilité : continuer à accepter strings bruts

**Fichiers à modifier:**
- `frontend/src/lib/media.ts` → renommer en `messages.ts` ou intégrer dans types
- `frontend/src/lib/utils/mainChatMessaging.ts` (sendChatMessage → JSON)
- `frontend/src/lib/utils/mainChatConnection.ts` (parser unifié)
- `frontend/src/lib/components/MessageBubble.svelte` (rendu unifié)

**Préparation Protobuf:**
- Définir schéma `.proto` pour messages
- Garder JSON court terme, migrer Protobuf plus tard

---

### 9. Avatars et initiales expéditeur

**Problématique:**
- Actuellement pas d'indication visuelle de l'expéditeur
- Distinction own/other messages via couleur background seulement

**Solution proposée:**
```svelte
<!-- Pour messages reçus (isOwn=false) -->
<div class="flex gap-2">
  <div class="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-white text-sm font-bold">
    {senderId[0].toUpperCase()}
  </div>
  <MessageBubble ... />
</div>
```

**Améliorations:**
- Avatar généré depuis initiale + couleur déterministe (hash du userId)
- Afficher pseudo au-dessus du message (senderId actuellement)
- Future: support avatar uploadé (via media-service)

**Fichiers à modifier:**
- `frontend/src/lib/components/ChatArea.svelte` (wrapper avatar)
- `frontend/src/lib/components/MessageBubble.svelte` (afficher pseudo)
- `frontend/src/lib/utils/avatar.ts` (nouvelle util: generateAvatarColor)

**Exemple génération couleur:**
```typescript
function generateAvatarColor(userId: string): string {
  const hash = userId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const hue = hash % 360;
  return `hsl(${hue}, 65%, 55%)`;
}
```

---

### 10. Regroupement messages par temps/jour

**Problématique:**
- Heure affichée sur chaque message (encombrant)  
- Pas de séparation visuelle jour/conversation

**Solution proposée:**
```svelte
{#each groupedMessages as group}
  {#if group.type === 'date_separator'}
    <div class="text-center text-xs text-gray-400 my-4">
      {group.date} <!-- "Aujourd'hui", "Hier", "12 mars 2026" -->
    </div>
  {:else if group.type === 'time_separator'}
    <div class="text-center text-xs text-gray-400 my-2">
      {group.time} <!-- "14:32" si pause > 15min -->
    </div>
  {:else}
    <MessageBubble ... showTime={false} />
  {/if}
{/each}
```

**Logique groupement:**
```typescript
function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let lastDate: string | null = null;
  let lastTimestamp: number | null = null;
  
  for (const msg of messages) {
    const msgDate = format(msg.timestamp, 'yyyy-MM-dd');
    const msgTime = msg.timestamp.getTime();
    
    // Changement de jour
    if (msgDate !== lastDate) {
      groups.push({ type: 'date_separator', date: formatDate(msg.timestamp) });
      lastDate = msgDate;
      lastTimestamp = null;
    }
    
    // Pause > 15min
    if (lastTimestamp && msgTime - lastTimestamp > 15 * 60 * 1000) {
      groups.push({ type: 'time_separator', time: format(msg.timestamp, 'HH:mm') });
    }
    
    groups.push({ type: 'message', message: msg });
    lastTimestamp = msgTime;
  }
  
  return groups;
}
```

**Fichiers à modifier:**
- `frontend/src/lib/components/ChatArea.svelte` (logique groupement)
- `frontend/src/lib/components/MessageBubble.svelte` (prop `showTime?: boolean`)
- `frontend/src/lib/utils/messageGrouping.ts` (nouvelle util)

---

## 📝 Ordre d'implémentation recommandé

1. **Étape 9** (Avatars) — Amélioration visuelle rapide, pas de changement protocole
2. **Étape 10** (Regroupement) — UX amélioration, pas de changement protocole
3. **Étape 8** (Migration JSON) — Fondation pour 6 et 7
4. **Étape 6** (Read receipts) — Feature visible, nécessite backend
5. **Étape 7** (Delete/Edit) — Feature complexe, dépend de 8

---

## 🔒 Considérations sécurité

- **Read receipts**: Ne pas exposer metadata (qui a lu quand) aux non-membres
- **Delete**: Suppression locale uniquement (E2EE → impossible de forcer suppression chez destinataire)
- **Edit**: Garder historique chiffré pour audit

---

## 🚀 Prochaine étape immédiate

Implémenter **Étape 9 (Avatars)** car:
- Pas de changement architecture backend
- Impact visuel immédiat
- Prépare UI pour futures features (profils utilisateurs)

