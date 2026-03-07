# Composants Canari

Ce projet a été refactorisé en composants réutilisables avec TailwindCSS.

## Structure des composants

### Composants de Base

#### `LoginForm.svelte`

Formulaire de connexion avec validation et styles Tailwind.

**Props:**

- `userId`: string
- `pin`: string
- `isLoggingIn`: boolean
- `loginError`: string
- `onUserIdChange`: (value: string) => void
- `onPinChange`: (value: string) => void
- `onLogin`: () => void
- `onReset`: () => void

#### `Navbar.svelte`

Barre de navigation principale.

**Props:**

- `isWsConnected`: boolean
- `onToggleLogs`: () => void
- `onLogout`: () => void

#### `StatusPill.svelte`

Indicateur de statut de connexion.

**Props:**

- `isConnected`: boolean

#### `EmptyState.svelte`

Composant réutilisable pour afficher un état vide.

**Props:**

- `icon`: Component (Lucide Svelte)
- `iconSize?`: number (default: 64)
- `title`: string
- `description`: string

### Composants de Conversation

#### `Sidebar.svelte`

Barre latérale contenant la liste des conversations.

**Props:**

- `conversations`: Map<string, Conversation>
- `selectedContact`: string | null
- `newContactInput`: string
- `newGroupInput`: string
- `onContactInputChange`: (value: string) => void
- `onGroupInputChange`: (value: string) => void
- `onAddContact`: () => void
- `onCreateGroup`: () => void
- `onSelectConversation`: (name: string) => void
- `isHidden?`: boolean

#### `ConversationTile.svelte`

Tuile de conversation individuelle.

**Props:**

- `contactName`: string
- `displayName`: string
- `lastMessage?`: string
- `isReady`: boolean
- `isSelected`: boolean
- `onClick`: () => void

### Composants de Chat

#### `ChatArea.svelte`

Zone de chat principale assemblant header, messages et compositeur.

**Props:**

- `conversation`: Conversation | null
- `messageText`: string
- `inviteMemberInput`: string
- `onMessageChange`: (value: string) => void
- `onInviteInputChange`: (value: string) => void
- `onSend`: () => void
- `onInviteMember`: () => void
- `onBack?`: () => void
- `isHidden?`: boolean

#### `ChatHeader.svelte`

En-tête de la zone de chat.

**Props:**

- `contactName`: string
- `displayName`: string
- `isReady`: boolean
- `inviteMemberInput`: string
- `onInviteInputChange`: (value: string) => void
- `onInviteMember`: () => void
- `onBack?`: () => void

#### `MessageBubble.svelte`

Bulle de message individuelle.

**Props:**

- `senderId`: string
- `content`: string
- `timestamp`: Date
- `isOwn`: boolean

#### `ChatComposer.svelte``

Compositeur de messages.

**Props:**

- `messageText`: string
- `onMessageChange`: (value: string) => void
- `onSend`: () => void

### Composants d'outils

#### `LogsPanel.svelte`

Panneau de logs et outils de développement.

**Props:**

- `logs`: string[]
- `onClose`: () => void
- `onGenerateKeyPackage?`: () => void
- `onAddMember?`: () => void
- `onProcessWelcome?`: () => void
- `lastKeyPackage?`: string
- `lastCommit?`: string
- `lastWelcome?`: string
- `incomingBytesHex?`: string
- `onIncomingBytesChange?`: (value: string) => void

## Utilisation

### Import groupé

```svelte
import {
  LoginForm,
  Navbar,
  Sidebar,
  ChatArea,
  LogsPanel
} from "$lib/components";
```

### Exemple d'utilisation

```svelte
<script lang="ts">
  import { LoginForm, Navbar, Sidebar, ChatArea } from "$lib/components";

  let isLoggedIn = $state(false);
  let userId = $state("");
  // ... autres états
</script>

{#if !isLoggedIn}
  <LoginForm
    {userId}
    {pin}
    {isLoggingIn}
    {loginError}
    onUserIdChange={(v) => (userId = v)}
    onLogin={handleLogin}
    onReset={resetAll}
  />
{:else}
  <div class="h-screen flex flex-col">
    <Navbar
      {isWsConnected}
      onToggleLogs={() => (showLogs = !showLogs)}
      onLogout={logout}
    />

    <main class="flex flex-1">
      <Sidebar
        {conversations}
        {selectedContact}
        onSelectConversation={selectConversation}
        ...
      />

      <ChatArea
        conversation={currentConvo}
        {messageText}
        onMessageChange={(v) => (messageText = v)}
        onSend={handleSendChat}
        ...
      />
    </main>
  </div>
{/if}
```

## Configuration TailwindCSS

Le projet utilise TailwindCSS avec une palette de couleurs personnalisée:

```js
// tailwind.config.js
export default {
  content: ["./src/**/*.{html,js,svelte,ts}"],
  theme: {
    extend: {
      colors: {
        "cn-dark": "#111827",
        "cn-yellow": "#facc15",
        "cn-yellow-hover": "#eab308",
        "cn-bg": "#f9fafb",
        "cn-border": "#e5e7eb",
      },
    },
  },
};
```

## Avantages de la modularisation

1. **Réutilisabilité** - Chaque composant peut être réutilisé dans différentes parties de l'application
2. **Maintenabilité** - Code plus facile à maintenir avec des responsabilités claires
3. **Testabilité** - Chaque composant peut être testé isolément
4. **Lisibilité** - Le code principal est plus lisible et concis
5. **Cohérence** - Design system cohérent avec TailwindCSS
6. **Évolutivité** - Facile d'ajouter de nouvelles fonctionnalités
