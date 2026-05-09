/**
 * Lightweight MLS recovery / queue observability.
 *
 * Enable verbose JSON logs: `localStorage.setItem('canari_mls_debug', '1')` then reload.
 * In development, metrics also log when `import.meta.env.DEV` is true.
 */

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
        | 'callback_retry'
        | 'web_exception_non_commit'
        | 'tauri_welcome_error'
        | 'tauri_gap'
        | 'tauri_unrecoverable';
      isWelcome?: boolean;
      isCommit?: boolean;
    }
  | {
      kind: 'epoch_cache';
      platform: 'tauri';
      groupId: string;
      epoch: number;
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
