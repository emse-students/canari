import type { MlsBatchProcessResult } from './IMlsService';

/** Raw batch row from WASM or Tauri IPC before normalisation. */
export type BatchDecryptRow = {
  ok: boolean;
  data?: Uint8Array | number[] | null;
  error?: string;
};

/** Maps a batch decrypt row vector to {@link MlsBatchProcessResult}. */
export function mapBatchDecryptRows(raw: BatchDecryptRow[]): MlsBatchProcessResult[] {
  return raw.map((row) => {
    if (!row.ok) {
      return { ok: false, error: String(row.error ?? 'decrypt error') };
    }
    const plain =
      row.data == null
        ? null
        : row.data instanceof Uint8Array
          ? row.data
          : Uint8Array.from(row.data);
    return { ok: true, plaintext: plain };
  });
}

/** Maps WASM batch decrypt rows to {@link MlsBatchProcessResult}. */
export function mapWasmBatchDecryptResults(
  raw: Array<{ ok: boolean; data?: Uint8Array | null; error?: string }>
): MlsBatchProcessResult[] {
  return mapBatchDecryptRows(raw);
}

/** Maps Tauri `recevoir_messages_batch` rows (`data` as `number[]`) to {@link MlsBatchProcessResult}. */
export function mapNativeBatchDecryptResults(
  raw: Array<{ ok: boolean; data?: number[] | null; error?: string }>
): MlsBatchProcessResult[] {
  return mapBatchDecryptRows(raw);
}

/** Invokes `process_incoming_messages_batch` on the live WASM client. */
export function wasmClientDecryptPage(
  client: {
    process_incoming_messages_batch: (
      groupId: string,
      messages: Uint8Array[]
    ) => Array<{ ok: boolean; data?: Uint8Array | null; error?: string }>;
  },
  groupId: string,
  messages: Uint8Array[]
): MlsBatchProcessResult[] {
  if (messages.length === 0) return [];
  const raw = client.process_incoming_messages_batch(groupId, messages);
  return mapWasmBatchDecryptResults(raw);
}
