import { Logger } from '@nestjs/common';

/**
 * Runs `body` with every `Logger` ERROR line CAPTURED instead of printed, and returns the lines.
 *
 * A spec that provokes an ERROR on purpose (a Redis that does not answer, a bar the row no longer
 * backs) must ASSERT it: the line is the behaviour under test, and an unasserted one printed into
 * the CI output reads as a fault. Capturing hides nothing the spec did not name - the caller
 * expects the exact lines, so a missing or extra one fails it.
 */
export async function capturingErrors(body: () => Promise<void>): Promise<string[]> {
  const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  try {
    await body();
    return spy.mock.calls.map((call) => String(call[0]));
  } finally {
    spy.mockRestore();
  }
}
