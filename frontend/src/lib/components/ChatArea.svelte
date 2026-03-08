<script lang="ts">
  import { ShieldCheck } from "lucide-svelte";
  import { tick } from "svelte";
  import ChatHeader from "./ChatHeader.svelte";
  import MessageBubble from "./MessageBubble.svelte";
  import ChatComposer from "./ChatComposer.svelte";
  import EmptyState from "./EmptyState.svelte";

  interface ChatMessage {
    id: string;
    senderId: string;
    content: string;
    timestamp: Date;
    isOwn: boolean;
  }

  interface Conversation {
    contactName: string;
    name: string;
    groupId: string;
    messages: ChatMessage[];
    isReady: boolean;
    mlsStateHex: string | null;
  }

  interface Props {
    conversation: Conversation | null;
    messageText: string;
    inviteMemberInput: string;
    onMessageChange: (value: string) => void;
    onInviteInputChange: (value: string) => void;
    onSend: () => void;
    onInviteMember: () => void;
    onBack?: () => void;
    isHidden?: boolean;
    authToken?: string;
    onFileSelected?: (file: File) => void;
    isUploading?: boolean;
  }

  let {
    conversation,
    messageText,
    inviteMemberInput,
    onMessageChange,
    onInviteInputChange,
    onSend,
    onInviteMember,
    onBack,
    isHidden = false,
    authToken = '',
    onFileSelected,
    isUploading = false,
  }: Props = $props();

  let chatContainer = $state<HTMLDivElement>();

  $effect(() => {
    if (conversation?.messages) {
      tick().then(() => {
        if (chatContainer) {
          chatContainer.scrollTop = chatContainer.scrollHeight;
        }
      });
    }
  });
</script>

<section
  class="flex-1 flex flex-col bg-cn-bg {isHidden ? 'hidden md:flex' : ''}"
>
  {#if conversation}
    <ChatHeader
      contactName={conversation.contactName}
      displayName={conversation.name}
      isReady={conversation.isReady}
      {inviteMemberInput}
      {onInviteInputChange}
      {onInviteMember}
      {onBack}
    />

    <!-- Messages -->
    <div
      bind:this={chatContainer}
      class="flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-2"
    >
      {#each conversation.messages as msg (msg.id)}
        <MessageBubble
          senderId={msg.senderId}
          content={msg.content}
          timestamp={msg.timestamp}
          isOwn={msg.isOwn}
          {authToken}
        />
      {/each}
    </div>

    <ChatComposer {messageText} {onMessageChange} {onSend} onFileSelected={onFileSelected} {isUploading} />
  {:else}
    <EmptyState
      icon={ShieldCheck}
      title="Aucun échange sélectionné"
      description="Canari protège vos communications avec le protocole MLS."
    />
  {/if}
</section>
