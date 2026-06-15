import type { IMlsService, MlsBatchProcessResult } from './IMlsService';
import { wasmClientDecryptPage } from './mlsBatchDecrypt';

/**
 * A stateful decrypt session for one group's history catch-up.
 *
 * Pages are decrypted in ratchet order; the underlying MLS ratchet advances across the
 * whole session and is committed back to the live client exactly once by {@link finish}.
 * This lets the heavy work run off-thread (Web worker) while the live client is reloaded
 * a single time instead of once per page.
 *
 * Contract:
 * - {@link decryptPage} may reject if the backing engine fails irrecoverably (worker crash);
 *   the caller should stop feeding pages and still call {@link finish}.
 * - {@link finish} always releases resources (worker, mutex) and is safe to call once,
 *   whether the session succeeded or a page rejected.
 */
export interface MlsDecryptSession {
  /** Decrypts one page of ciphertexts in order, returning a per-message outcome. */
  decryptPage(messageBytesList: Uint8Array[]): Promise<MlsBatchProcessResult[]>;
  /** Commits accumulated ratchet state to the live client (if any) and releases resources. */
  finish(): Promise<void>;
}

/**
 * Sequential, in-place decrypt session backed by the live MLS client.
 *
 * Each page is decrypted by mutating the live client directly, so there is nothing to
 * commit on {@link MlsDecryptSession.finish}. Used by Tauri (native is fast enough) and as
 * the Web fallback when the crypto worker is unavailable - a single, unambiguous code path.
 */
export function createSequentialDecryptSession(
  service: Pick<IMlsService, 'processIncomingMessage' | 'processIncomingMessagesBatch'>,
  groupId: string
): MlsDecryptSession {
  return {
    async decryptPage(messageBytesList: Uint8Array[]): Promise<MlsBatchProcessResult[]> {
      if (messageBytesList.length === 0) return [];
      if (service.processIncomingMessagesBatch) {
        return service.processIncomingMessagesBatch(groupId, messageBytesList);
      }
      const results: MlsBatchProcessResult[] = [];
      for (const bytes of messageBytesList) {
        try {
          const plaintext = await service.processIncomingMessage(groupId, bytes);
          results.push({ ok: true, plaintext });
        } catch (e) {
          results.push({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return results;
    },
    async finish(): Promise<void> {
      // Live client already holds the advanced ratchet; nothing to commit.
    },
  };
}
