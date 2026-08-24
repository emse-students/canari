/**
 * Lightweight MLS recovery / queue observability.
 *
 * Enable verbose JSON logs: `localStorage.setItem('canari_mls_debug', '1')` then reload.
 * In development, metrics also log when `import.meta.env.DEV` is true.
 */

import type { OutboxEntry } from '$lib/db/types';

export type MlsMetricEvent =
  | {
      kind: 'queue_ack';
      platform: 'web' | 'tauri';
      count: number;
    }
  | {
      kind: 'queue_skip_ack';
      platform: 'web' | 'tauri';
      reason:
        | 'callback_retry' // messageCallback returned false → retry later
        | 'exception_non_commit' // exception on non-commit message → retry on reconnect
        | 'welcome_error'; // Welcome processing error → retry on reconnect
      isWelcome?: boolean;
      isCommit?: boolean;
    }
  | {
      kind: 'epoch_cache';
      platform: 'tauri';
      groupId: string;
      epoch: number;
    }
  | {
      kind: 'outbox_pending_count';
      count: number;
    }
  | {
      kind: 'outbox_flush_attempt';
      conversationId: string;
    }
  | {
      kind: 'outbox_upload_attempt';
      conversationId: string;
    }
  | {
      kind: 'outbox_flush_success';
      conversationId: string;
      /** Compose-to-sent latency in milliseconds. */
      latencyMs: number;
    }
  | {
      kind: 'outbox_permanent_error';
      conversationId: string;
      /**
       * What was lost. A `control` entry dying with its group is a read receipt or a reaction losing
       * a race to a deletion and costs nobody anything; a `text`, `reply` or `media` entry dying is
       * a message the user WROTE and will never see sent. Same event, opposite severity - so the
       * discriminator belongs ON the event, or nothing downstream can tell the two apart.
       */
      entryKind: OutboxEntry['kind'];
      /**
       * Why it is permanent. None is retryable, and `evicted-late` is not the same incident as
       * `evicted`: the first learnt the eviction from a FACT (`isGroupActive`), the second learnt it
       * from a REFUSED SEND, which means the fact-based path missed it. A rate on the second is a
       * measurement of that miss, and it is the reason the two are not one bucket.
       */
      cause: 'group-deleted' | 'evicted' | 'evicted-late';
    };

function isMetricsVerbose(): boolean {
  if (typeof localStorage === 'undefined') return import.meta.env.DEV;
  return localStorage.getItem('canari_mls_debug') === '1' || import.meta.env.DEV;
}

/** Fire-and-forget; safe in hot paths. */
export function logMlsMetric(event: MlsMetricEvent): void {
  if (!isMetricsVerbose()) return;
  try {
    console.info('[MLS][METRIC]', JSON.stringify({ t: Date.now(), ...event }));
  } catch {
    /* ignore */
  }
}
