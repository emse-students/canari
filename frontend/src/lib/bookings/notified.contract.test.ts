import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BOOKING_NOTIFICATIONS_LIVE } from './notified';

/**
 * The switch of the bookings notices exists twice - the server sends, the client says whether it
 * does - and no compiler spans the service boundary. This reads the server file, so flipping one
 * side only fails here instead of a screen promising a notice the server never sends.
 */
const SERVER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/social-service/src/bookings/booking-notifications.service.ts'
);

describe('the bookings notices switch', () => {
  it('reads the same on the client as on the server', () => {
    const src = readFileSync(SERVER, 'utf8');
    const server = /export const BOOKING_NOTIFICATIONS_ENABLED = (true|false);/.exec(src)?.[1];
    expect(server).toBeDefined();
    expect(BOOKING_NOTIFICATIONS_LIVE).toBe(server === 'true');
  });
});
