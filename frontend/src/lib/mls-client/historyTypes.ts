/** One Redis-stream history row as returned by the delivery service. */
export type HistoryStreamRow = {
  id?: string;
  sender_id: string;
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
