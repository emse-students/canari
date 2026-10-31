/**
 * THE NATIVE RING'S COMMANDS, ANSWERED AS THE TAURI SIDE ANSWERS THEM (`page_ring.rs`).
 *
 * Every `TauriMlsService` reports its gateway socket to the native ring from the socket's setter
 * (`pageGatewaySocket.ts`), and every report first asks the document generation. In the app the
 * Rust side always answers it; a suite whose `invoke` mock does not would see the report fail and
 * WARN - a warning no test is about, which hides the next real one. So a suite that opens or closes
 * a socket through a mocked `invoke` answers these commands with this, and its own commands as it
 * did before:
 *
 *   vi.mock('@tauri-apps/api/core', async () => ({
 *     invoke: vi.fn((await import('../../test/mocks/pageRingInvoke')).answerPageRing),
 *   }));
 *
 * or, inside a suite's own implementation, `answerPageRing(command)` for the commands it does not
 * handle.
 */

/** The generation the mocked native side reports for the one document a suite runs in. */
export const MOCK_PAGE_RING_DOCUMENT = 1;

/**
 * Answers `page_ring_document` (the document generation) and the two statements (which answer
 * nothing); any other command answers `undefined`, as a bare `vi.fn()` did.
 */
export async function answerPageRing(command: string): Promise<unknown> {
  return command === 'page_ring_document' ? MOCK_PAGE_RING_DOCUMENT : undefined;
}
