/** One Redis-stream history row as returned by the delivery service. */
export type HistoryStreamRow = {
  id?: string;
  sender_id: string;
  /**
   * The DEVICE that wrote the frame, which is the only thing that can tell a replay its own rows
   * from the ones it must read.
   *
   * `history:{groupId}` is one stream per group and necessarily holds this device's own frames -
   * the other members read it. MLS refuses them by construction (`CannotDecryptOwnMessage`), and
   * `sender_id` cannot filter them out because the SAME user's other device wrote frames that are
   * both decryptable and wanted. Recorded by the server at `XADD`, from the request body, which is
   * the last point where it is known.
   *
   * Absent on rows written before 2026-08-15. Those still reach MLS and are still classified at
   * the throw, which is the shim and its own removal condition - see
   * `docs/wiki/legacy-compatibility.md`.
   */
  sender_device_id?: string;
  content: string;
  timestamp: string;
  /**
   * `'1'` when the frame must not notify - a mutation (reaction, edit, deletion, read receipt)
   * rather than a message. Recorded by the server at write time because the payload is ciphertext
   * and nothing downstream can classify it afterwards.
   *
   * Absent on entries written before the stream carried mutations at all, where a frame being in
   * the stream already implied it was visible.
   */
  silent?: string;
};

/**
 * One history page, plus the stream head the server saw when it read it.
 *
 * `head` is the upper bound a walk must carry for the rest of its pages (`until`), and it is what
 * keeps the archive replay and the live delivery queue from ever handing MLS the same frame. The
 * archive holds every frame, including those still queued for delivery, so a walk bounded by "the
 * tail whenever I reach it" necessarily covers rows appended while it was running - exactly the
 * ones the queue is about to deliver. Pinned at the start, the two sets are disjoint by
 * construction, and no row is fetched, decrypted or ledgered twice.
 *
 * Undefined when the group's stream is empty, or when the server predates the bound - see
 * `docs/wiki/legacy-compatibility.md`.
 */
export type HistoryPage = {
  rows: HistoryStreamRow[];
  head?: string;
};
