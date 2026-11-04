import { MessageCirclePlus } from '@lucide/svelte';
import { m } from '$lib/paraglide/messages';
import type { GuideDefinition } from '../guideTypes';

/**
 * FIRST-TIME HINT - starting a conversation. The new-conversation sheet is a modal, so the hint
 * points at the "+" that OPENS it (`SidebarHeaderControls`, `chat.new`), and its body also names how
 * to open an existing conversation from the list. Left out, not-rendered, where the list is not
 * drawn (a phone with a conversation already open).
 */
export const chatsHint: GuideDefinition = {
  id: 'hint-chats',
  kind: 'hint',
  appliesTo: (pathname) => pathname === '/chat',
  replay: { label: m.guide_hint_chats_title, route: '/chat' },
  steps: [
    {
      id: 'new-chat',
      anchor: 'chat.new',
      icon: MessageCirclePlus,
      title: m.guide_hint_chats_title,
      body: m.guide_hint_chats_body,
    },
  ],
};
