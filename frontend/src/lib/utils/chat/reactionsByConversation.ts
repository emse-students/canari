import { SvelteMap } from 'svelte/reactivity';
import type { MessageReaction } from '$lib/types';
import { mergeReactions } from './messageReactions';

/**
 * WHAT THE SCREEN DRAWS A MESSAGE'S REACTIONS FROM, KEYED LIKE THE STORED ROW: by conversation and
 * message id. A message id is chosen by the frame that carries it, so two conversations may each hold
 * a message under the same id - the stored row is keyed by the pair (SQLite v23, IndexedDB v15,
 * `docs/wiki/protocols/history-reconciliation.md`), and this map follows it, so a reaction of one
 * conversation is never drawn on, nor written into, the row of another. Every read and write names
 * the conversation; there is no lookup by id alone.
 *
 * The conversation is lowercased, as the stored key is (`persistLocalMutation`). Reactive: each entry
 * is a `SvelteMap` slot, so a component reading one re-renders when that one changes.
 */
export class ReactionsByConversation {
  readonly #slots = new SvelteMap<string, MessageReaction[]>();

  /** The map key of one message of one conversation. */
  static #key(conversationId: string, messageId: string): string {
    return `${conversationId.toLowerCase()}\n${messageId}`;
  }

  /** The reactions held for `messageId` of `conversationId`, if any. */
  get(conversationId: string, messageId: string): MessageReaction[] | undefined {
    return this.#slots.get(ReactionsByConversation.#key(conversationId, messageId));
  }

  /** Whether reactions are held for `messageId` of `conversationId`. */
  has(conversationId: string, messageId: string): boolean {
    return this.#slots.has(ReactionsByConversation.#key(conversationId, messageId));
  }

  /** Holds `reactions` for `messageId` of `conversationId`. */
  set(conversationId: string, messageId: string, reactions: MessageReaction[]): this {
    this.#slots.set(ReactionsByConversation.#key(conversationId, messageId), reactions);
    return this;
  }

  /** Forgets `messageId` of `conversationId`; whether it was held. */
  delete(conversationId: string, messageId: string): boolean {
    return this.#slots.delete(ReactionsByConversation.#key(conversationId, messageId));
  }

  /**
   * Carries the reactions of `messageIds` from `from` to `to`, as their stored rows move
   * (`IStorage.moveMessages`): a message the destination already holds reactions for keeps the
   * convergent union of both (`mergeReactions`). Returns how many messages it carried.
   */
  move(from: string, to: string, messageIds: readonly string[]): number {
    let carried = 0;
    for (const id of messageIds) {
      const held = this.get(from, id);
      if (!held) continue;
      this.delete(from, id);
      const there = this.get(to, id);
      this.set(to, id, there ? (mergeReactions(there, held) ?? there) : held);
      carried++;
    }
    return carried;
  }

  /** Forgets everything (a session ending). */
  clear(): void {
    this.#slots.clear();
  }

  /** The number of messages reactions are held for. */
  get size(): number {
    return this.#slots.size;
  }

  /**
   * The view of ONE conversation, by message id alone - what a component drawing that conversation
   * and a pipeline step bound to it read and write. Reads stay reactive.
   */
  of(conversationId: string): ConversationReactions {
    return {
      get: (messageId) => this.get(conversationId, messageId),
      has: (messageId) => this.has(conversationId, messageId),
      set: (messageId, reactions) => {
        this.set(conversationId, messageId, reactions);
      },
      delete: (messageId) => this.delete(conversationId, messageId),
    };
  }
}

/** The reactions of one conversation, by message id (see {@link ReactionsByConversation.of}). */
export interface ConversationReactions {
  get(messageId: string): MessageReaction[] | undefined;
  has(messageId: string): boolean;
  set(messageId: string, reactions: MessageReaction[]): void;
  delete(messageId: string): boolean;
}
