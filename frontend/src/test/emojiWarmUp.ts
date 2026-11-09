/**
 * THE EMOJI PICKER'S WARM-UP DOES NOT RUN IN A TEST.
 *
 * `ChatComposer` schedules `warmEmojiPicker` once it has painted (`whenIdleAfterPaint`), and that
 * fetches the emoji dataset. Every suite that mounts a composer (or a chat area holding one) would
 * then reach for the real network, which `noRealNetwork.ts` fails, and would also see two extra
 * `requestAnimationFrame` callbacks in suites that step frames by hand. The warm-up is an
 * optimisation with no observable contract for them, so the scheduling function is replaced by a
 * no-op for the whole suite; `emojiPreload.test.ts` exercises the real pure parts (`importActual`).
 */
import { vi } from 'vitest';

vi.mock('$lib/utils/emojiPreload', async (importActual) => ({
  ...(await importActual<typeof import('$lib/utils/emojiPreload')>()),
  whenIdleAfterPaint: () => {},
}));
