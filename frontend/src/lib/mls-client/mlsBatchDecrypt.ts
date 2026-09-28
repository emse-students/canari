import type { MlsBatchProcessResult } from './IMlsService';

/** Raw batch row from WASM or Tauri IPC before normalisation. */
export type BatchDecryptRow = {
  ok: boolean;
  data?: Uint8Array | number[] | null;
  /** The sender OpenMLS verified (`userId:deviceId`), beside `data` and only with it. */
  sender?: string | null;
  error?: string;
};

/** Maps a batch decrypt row vector to {@link MlsBatchProcessResult}. */
export function mapBatchDecryptRows(raw: BatchDecryptRow[]): MlsBatchProcessResult[] {
  return raw.map((row) => {
    if (!row.ok) {
      return { ok: false, error: String(row.error ?? 'decrypt error') };
    }
    if (row.data == null) return { ok: true, plaintext: null };
    const plain = row.data instanceof Uint8Array ? row.data : Uint8Array.from(row.data);
    // Native omits `sender` when the credential was unreadable (serde skips a `None`), WASM sends
    // `null`: both mean "a plaintext whose sender cannot be checked", and must not read as a path
    // that carries no sender at all.
    return { ok: true, plaintext: plain, sender: row.sender ?? null };
  });
}

/** Maps WASM batch decrypt rows to {@link MlsBatchProcessResult}. */
export function mapWasmBatchDecryptResults(raw: BatchDecryptRow[]): MlsBatchProcessResult[] {
  return mapBatchDecryptRows(raw);
}

/** Maps Tauri `recevoir_messages_batch` rows (`data` as `number[]`) to {@link MlsBatchProcessResult}. */
export function mapNativeBatchDecryptResults(raw: BatchDecryptRow[]): MlsBatchProcessResult[] {
  return mapBatchDecryptRows(raw);
}

/** Invokes `process_incoming_messages_batch` on the live WASM client. */
export function wasmClientDecryptPage(
  client: {
    process_incoming_messages_batch: (groupId: string, messages: Uint8Array[]) => BatchDecryptRow[];
  },
  groupId: string,
  messages: Uint8Array[]
): MlsBatchProcessResult[] {
  if (messages.length === 0) return [];
  const raw = client.process_incoming_messages_batch(groupId, messages);
  return mapWasmBatchDecryptResults(raw);
}
