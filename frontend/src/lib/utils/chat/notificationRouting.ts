import { isChannelConversationId } from './channelCrypto';

/**
 * The app route that can display a given chat-notification target. DMs and groups live under
 * `/chat`; community channels (`channel_<uuid>`) live under `/communities`. A channel deep-link
 * opened on `/chat` would land on the wrong view, so notification handling routes by target type.
 */
export function chatDeepLinkRoute(conversationId: string): '/chat' | '/communities' {
  return isChannelConversationId(conversationId) ? '/communities' : '/chat';
}
