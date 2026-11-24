/**
 * The client's `REEL_MEDIA_EXPIRED` is a MIRROR of social-service's: the publish queue re-uploads on
 * it, so a rename on one side would turn a curable refusal back into a Retry that never succeeds.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REEL_MEDIA_EXPIRED } from './reelMediaExpired';

describe('REEL_MEDIA_EXPIRED', () => {
  it("equals social-service's code", () => {
    const server = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../apps/social-service/src/internal/reel-media.ts'
      ),
      'utf8'
    );
    const declared = /export const REEL_MEDIA_EXPIRED = '([^']+)';/.exec(server);
    expect(declared?.[1]).toBe(REEL_MEDIA_EXPIRED);
  });
});
