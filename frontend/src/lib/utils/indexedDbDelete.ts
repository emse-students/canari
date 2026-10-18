/**
 * Deletes one IndexedDB database by name and says what happened, instead of leaving the caller to
 * guess: the promise ALWAYS resolves (a wipe goes on to its next step), and every outcome that is
 * not a clean delete is logged at a level that accuses.
 *
 * @param tag the caller's log prefix, e.g. `[RESET]`
 * @returns `true` only when the database is gone; `false` when the delete failed or is deferred
 */
export function deleteIndexedDbByName(name: string, tag: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve(true);
    // A DELETE THAT FAILED USED TO LOOK EXACTLY LIKE ONE THAT WORKED. `resolve()` alone left the
    // survey as the only witness, which says WHAT remains and never WHY - and the two databases
    // HEAL-REVOKE-5 found surviving were distinguishable only by the one that happened to log
    // `blocked`. Every swallowed branch logs.
    req.onerror = () => {
      console.error(`${tag} could not delete ${name}:`, req.error);
      resolve(false);
    };
    // Reached only if something else still holds the database open - a second tab, for instance.
    // The delete then completes when that connection closes, so the reset is not lost, only
    // deferred; saying so is what stops it reading as success.
    req.onblocked = () => {
      console.warn(`${tag} ${name} is still open elsewhere - delete deferred`);
      resolve(false);
    };
  });
}
