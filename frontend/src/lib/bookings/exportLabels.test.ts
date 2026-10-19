import { describe, expect, it } from 'vitest';
import { bookingExportLabels } from './api';

/**
 * The server refuses an export whose words miss one key or carry an empty one (`export-labels`,
 * `booking-export.ts`), and it has no default to fall back on - so every word this client sends is
 * checked here, in both languages' resolution.
 */
describe('bookingExportLabels', () => {
  it("sends every word the server's export requires, none empty or over 200 characters", () => {
    const labels = bookingExportLabels();
    expect(Object.keys(labels).sort()).toEqual(
      [
        'cancelled',
        'date',
        'end',
        'file',
        'fileDeleted',
        'holder',
        'participants',
        'resource',
        'start',
        'status',
      ].sort()
    );
    for (const [key, word] of Object.entries(labels)) {
      expect(word.trim().length, key).toBeGreaterThan(0);
      expect(word.length, key).toBeLessThanOrEqual(200);
    }
  });
});
