<script lang="ts">
  import { User, Users, Hand } from 'lucide-svelte';
  import ConversationTile from './ConversationTile.svelte';

  interface Conversation {
    contactName: string;
    name: string;
    groupId: string;
    messages: any[];
    isReady: boolean;
    mlsStateHex: string | null;
  }

  interface Props {
    conversations: Map<string, Conversation>;
    selectedContact: string | null;
    newContactInput: string;
    newGroupInput: string;
    onContactInputChange: (value: string) => void;
    onGroupInputChange: (value: string) => void;
    onAddContact: () => void;
    onCreateGroup: () => void;
    onSelectConversation: (name: string) => void;
    isHidden?: boolean;
  }

  let {
    conversations,
    selectedContact,
    newContactInput,
    newGroupInput,
    onContactInputChange,
    onGroupInputChange,
    onAddContact,
    onCreateGroup,
    onSelectConversation,
    isHidden = false,
  }: Props = $props();

  function handleContactKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && newContactInput.trim()) {
      onAddContact();
    }
  }

  function handleGroupKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && newGroupInput.trim()) {
      onCreateGroup();
    }
  }
</script>

<aside
  class="w-80 bg-white border-r border-cn-border flex flex-col {isHidden ? 'hidden md:flex' : ''}"
>
  <!-- Header -->
  <div class="p-4 border-b border-cn-bg space-y-3">
    <!-- Add Contact -->
    <div class="flex gap-2">
      <input
        type="text"
        value={newContactInput}
        oninput={(e) => onContactInputChange(e.currentTarget.value)}
        onkeydown={handleContactKeydown}
        placeholder="Nouveau contact..."
        class="flex-1 px-4 py-3 bg-cn-bg rounded-2xl text-sm outline-none focus:shadow-[inset_0_0_0_2px] focus:shadow-cn-yellow"
      />
      <button
        onclick={onAddContact}
        class="w-11 h-11 bg-cn-dark text-cn-yellow rounded-2xl flex items-center justify-center hover:bg-gray-800 transition-colors"
        title="Ajouter un contact"
      >
        <User size={20} />
      </button>
    </div>

    <!-- Create Group -->
    <div class="flex gap-2">
      <input
        type="text"
        value={newGroupInput}
        oninput={(e) => onGroupInputChange(e.currentTarget.value)}
        onkeydown={handleGroupKeydown}
        placeholder="Nouveau groupe..."
        class="flex-1 px-4 py-3 bg-cn-bg rounded-2xl text-sm outline-none focus:shadow-[inset_0_0_0_2px] focus:shadow-cn-yellow"
      />
      <button
        onclick={onCreateGroup}
        class="w-11 h-11 bg-cn-dark text-cn-yellow rounded-2xl flex items-center justify-center hover:bg-gray-800 transition-colors"
        title="Créer un groupe"
      >
        <Users size={20} />
      </button>
    </div>
  </div>

  <!-- Conversation List -->
  <div class="flex-1 overflow-y-auto p-2">
    {#each Array.from(conversations.entries()) as [name, convo] (name)}
      <ConversationTile
        contactName={name}
        displayName={convo.name}
        lastMessage={convo.messages.length > 0
          ? convo.messages[convo.messages.length - 1].content
          : undefined}
        isReady={convo.isReady}
        isSelected={selectedContact === name}
        onClick={() => onSelectConversation(name)}
      />
    {/each}

    {#if conversations.size === 0}
      <div class="text-center py-8 px-4 text-gray-500">
        <div class="mb-4 opacity-50 flex justify-center items-center">
          <Hand size={48} />
        </div>
        <p class="text-sm">Votre messagerie est vide. Cherchez un pseudo pour commencer.</p>
      </div>
    {/if}
  </div>
</aside>
