/**
 * Centralized copy for post-interaction push notifications.
 * Fixed French locale - there is no per-user locale stored server-side yet, so every
 * recipient gets the same wording (mirrors the chat-delivery-service reaction push,
 * which is French for the same reason).
 */

export function pushReactionTitle(): string {
  return 'Nouvelle réaction';
}

export function pushReactionBody(actorName: string, reactionType: string): string {
  return `${actorName} a réagi ${reactionType} à votre publication`;
}

export function pushCommentTitle(actorName: string): string {
  return `${actorName} a commenté`;
}

export function pushCommentBody(preview: string): string {
  return preview || 'Nouveau commentaire';
}

export function pushReplyTitle(actorName: string): string {
  return `${actorName} a répondu`;
}

export function pushReplyBody(preview: string): string {
  return preview || 'Nouvelle réponse';
}

export function pushMentionTitle(actorName: string): string {
  return `${actorName} vous a mentionné`;
}

export function pushMentionBody(preview: string): string {
  return preview || 'Vous avez été mentionné dans un commentaire';
}
