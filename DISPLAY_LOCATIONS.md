# Document: Emplacements d'affichage des IDs et des noms utilisateur

Ce document liste **tous les endroits** où les IDs utilisateur et les noms d'affichage sont visibles dans l'interface.

À toi de décider pour chaque location: afficher l'ID, le display name, ou rien du tout.

---

## 🔹 Messagerie / Chat

### 1. **ChatHeader.svelte** - En-têtes de conversation

- **Ligne ~69**: `{effectiveDisplayName}`
  - **Actuellement**: Display name du contact (ou sync) pour direct, nom du groupe pour groupes
  - **À DÉCIDER**: Très bien.

- **Ligne ~170** (Members section): `{member}` brut dans aria-label
  - Affichage dans le tooltip du bouton "Retirer"
  - **Actuellement**: Affiche l'ID du membre
  - **À DÉCIDER**: Afficher le firstname et le lastname du membre, name en fallback, puis ID.

### 2. **ChatMessageGroups.svelte** - Noms des expéditeurs de messages

- **Ligne 164**: `{resolvedSenderNames[msg.senderId] || msg.senderId}`
  - Affiche le nom de l'expéditeur au-dessus de ses messages (groupes)
  - **Actuellement**: Display name résolu ou ID en fallback
  - **À DÉCIDER**: Afficher le firstname du membre, name en fallback, puis ID.

### 3. **ChatComposer.svelte** - Réponse à un message

- **Ligne ~77**: `{replySenderDisplayName || replyingTo.senderId}`
  - Affiche "Répondre à [nom]" dans la barre de prévisualisation
  - **Actuellement**: Display name ou ID en fallback
  - **À DÉCIDER**: Afficher le firstname du membre, name en fallback, puis ID.

### 4. **ConversationTile.svelte** - Tuiles de conversation dans la sidebar

- **Ligne ~38**: `{effectiveDisplayName}`
  - Nom du contact/groupe dans la liste des conversations
  - **Actuellement**: Display name ou sync
  - **À DÉCIDER**: Afficher le firstname et le lastname du membre, name en fallback, puis ID.

### 5. **ChannelMembersSidebar.svelte** - Liste des membres du canal

- **Ligne ~79 et ~94**: `<UserName userId={member.name} .../>`
  - Affiche les noms des admins et membres du canal
  - **Actuellement**: Utilise composant `UserName` (voir plus bas)
  - **À DÉCIDER**: Afficher le firstname et le lastname du membre, name en fallback, puis ID.

---

## 🔹 Posts / Commentaires

### 6. **PostComments.svelte** - Auteurs des commentaires

- **Ligne ~66**: `{comment.displayName || comment.userId}`
  - Affiche le nom de l'auteur d'un commentaire
  - **Actuellement**: Display name ou ID en fallback
  - **À DÉCIDER**: Afficher le firstname et le lastname du membre, name en fallback, puis ID.

### 7. **PostCard.svelte** - Messages de statut (réactions, votes, événements)

- Messages génériques:
  - "X a voté"
  - "X s'est inscrit à l'événement"
  - Commentaires de réactions
  - **Actuellement**: Pas visible directement dans le component (utilise data backend)
  - **À DÉCIDER**: Afficher le firstname et le lastname du membre, name en fallback, puis ID.

### 8. **PostEventButtons.svelte** - Liste des inscrits

- **Ligne ~27** (registrants list): `btn.registrants.includes(currentUserId)`
  - Affiche qui est inscrit aux événements
  - **Actuellement**: Stocké comme IDs en backend
  - **À DÉCIDER**: Afficher le firstname et le lastname du membre, name en fallback, puis ID.

---

## 🔹 Composant partagé UserName

### 9. **UserName.svelte** - Composant multi-usage

- **Location**: `src/lib/components/shared/UserName.svelte`
- **Utilisé dans**:
  - ChatHeader (membres du groupe)
  - ChannelMembersSidebar (admins + members)
  - Tous les autres endroits qui affichent des noms
- **Actuellement**: Affiche l'ID brut ou le display name si disponible
- **À DÉCIDER**: Afficher le firstname et le lastname du membre, name en fallback, puis ID.

---

## 🔹 Profil / Identité

### 10. **Profile page** (`/profile`)

- Affiche le profil utilisateur actuel
- **À DÉCIDER**: Afficher le firstname et le lastname du membre, name en fallback. Pas besoin de mettre l'id.

### 11. **Avatar.svelte** - Composant Avatar

- **Utilisé partout** pour afficher les avatars des utilisateurs
- Le tooltip/aria-label affiche probablement l'ID
- **À DÉCIDER**: L'avatar va bientôt être autre chose, mais en fallback (placeholder), il faudrait que ce soient les initiales du firstname et du lastname (à défaut le name, et à défaut l'id) qui servent de base pour générer l'image du profil.

---

## 🔹 Notifications / Système

### 12. **MainChatPage.svelte** - Notifications système

- **Ligne ~231+**: Notifications de membership (canal rejoint/quitté)
  - "Vous avez été ajouté au canal #nom"
  - "Vous avez été retiré du canal #nom"
- **Actuellement**: Affiche le nom du canal (OK)
- **À DÉCIDER**: OK comme c'est

### 13. **Channel notifications** - Membership join/kick

- "Vous avez été ajouter au canal prive #X"
- "Vous avez été ajoute au canal #X"
- "Vous avez été retire du canal #X"
- **Actuellement**: Affiche le nom du canal
- **À DÉCIDER**: OK

---

## 🔹 Synchronisation / Groupes

### 14. **ChatHeader.svelte** - Titre du groupe

- **Ligne ~69**: Nom du groupe affiché en header
- **À DÉCIDER**: OK

### 15. **Modal de renommage du groupe**

- Affiche le nom du groupe actuel dans l'input
- **À DÉCIDER**: OK

---

## 🔹 Autres UI Elements

### 16. **Badges / Tags affichant l'utilisateur**

- Exemple: "Vous" dans une réaction
- **À DÉCIDER**: OK (c'est une action propre)

### 17. **Messages système** (exemple: "X a quitté")

- **Actuellement**: Affiche probablement l'ID brut
- **À DÉCIDER**: Afficher le firstname et le lastname du membre, name en fallback, puis ID.

---

## 🔹 Backend / API

### 18. **Posts Service** (`social-service`)

- **Ligne 67-71**: Récupère `displayName` pour les auteurs des posts
- **À DÉCIDER**: OK, c'est du backend

### 19. **Message Events** (proto)

- Contient `senderId` et `senderDeviceId` dans les enveloppes
- **À DÉCIDER**: OK, c'est du backend

---
