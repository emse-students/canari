// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { forgetAtRestMarkerOnceDataIsGone } from './sessionAuth';

/**
 * THE RESET FREES A HARDWARE-HELD KEY'S ENTRY ONLY ONCE THE DATA IT OPENS IS GONE.
 *
 * The marker is what makes the at-rest guard refuse every write of that keystore entry; forgetting
 * it while the database survived would let the next unlock store a new key over the only one that
 * opens it. The account deletion already refused in that case (`accountLocalWipe.ts`); the reset
 * did not until 2026-10-23.
 */
describe('forgetAtRestMarkerOnceDataIsGone', () => {
  it('keeps the marker, and says so at ERROR, when the database was not cleared', async () => {
    const forget = vi.fn(async () => {});
    const log = vi.fn();
    await forgetAtRestMarkerOnceDataIsGone(false, 'user-1', { forget }, log);
    expect(forget).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ERROR'));
  });

  it('forgets the marker once the database was cleared', async () => {
    const forget = vi.fn(async () => {});
    const log = vi.fn();
    await forgetAtRestMarkerOnceDataIsGone(true, 'user-1', { forget }, log);
    expect(forget).toHaveBeenCalledWith('user-1');
  });

  it('logs a failed forget at ERROR rather than throwing out of the reset', async () => {
    const log = vi.fn();
    await forgetAtRestMarkerOnceDataIsGone(
      true,
      'user-1',
      {
        forget: async () => {
          throw new Error('io');
        },
      },
      log
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ERROR'));
  });

  it('is fed by the reset with a flag set only after `clear()` returned', () => {
    // WHY A SOURCE TEST: the reset itself runs over a live storage, an MLS service and the keystore;
    // the decision is the function above, and what this pins is that the reset hands it the truth.
    const source = readFileSync(join(__dirname, 'sessionAuth.ts'), 'utf8');
    const start = source.indexOf('async function resetDeviceAsFreshImpl');
    const body = source.slice(start, source.indexOf('\nexport ', start + 1));
    const clearAt = body.indexOf('await storageToClear.clear();');
    const flagAt = body.indexOf('databaseCleared = true;');
    expect(clearAt).toBeGreaterThan(-1);
    expect(flagAt).toBeGreaterThan(clearAt);
    expect(body).toContain('forgetAtRestMarkerOnceDataIsGone(\n      databaseCleared,');
    expect(body.indexOf('tauriHardwareKeyPort.forget(')).toBe(-1);
  });
});
