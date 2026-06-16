/** One Redis-stream history row as returned by the delivery service. */
export type HistoryStreamRow = {
  id?: string;
  sender_id: string;
  content: string;
  timestamp: string;
};
