import { untrack } from 'svelte';
import {
  currentEndingFacts,
  settleEndingFacts,
  snapshotConversations,
  watchEndings,
  type KnownConversations,
  type WatchedConversation,
} from './endedConversations';

/**
 * Runs the endings watcher as an effect of the calling component: whenever the conversation list
 * OR an ending fact changes, it looks at the list and calls `onEnded` for each id whose
 * notifications must go ({@link watchEndings}).
 *
 * The facts are reactive (`SvelteSet`s) and READ here, tracked: a confirmation arriving for a row
 * that is already `removed` writes no map entry, and without that read the effect would sleep until
 * some unrelated write - and a kill in between would lose the fact. Settling the facts is a write,
 * done untracked.
 *
 * Must be called during component initialisation, like any `$effect`.
 */
export function watchConversationEndings(
  read: () => { signedIn: boolean; rows: Iterable<WatchedConversation> },
  onEnded: (id: string) => void
): void {
  let known: KnownConversations = new Map();
  $effect(() => {
    const { signedIn, rows } = read();
    const next = snapshotConversations(rows);
    const facts = currentEndingFacts();
    const watched = untrack(() => watchEndings(signedIn, known, next, facts));
    known = watched.known;
    untrack(() => settleEndingFacts(signedIn, next));
    for (const id of watched.ended) onEnded(id);
  });
}
