/**
 * notifNav - pending notification navigation state.
 *
 * When a system notification is clicked, the click handler stores the target
 * conversation ID here and calls goto('/chat'). MainChatPage watches this via
 * a $effect and calls selectConversation() to open the right thread.
 */

let pendingConvoId = $state<string | null>(null);

export const notifNav = {
  get pending(): string | null {
    return pendingConvoId;
  },
  navigate(id: string) {
    pendingConvoId = id;
  },
  clear() {
    pendingConvoId = null;
  },
};
