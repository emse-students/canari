import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ROWS BEFORE RATCHET IS ONLY AS GOOD AS ITS REGISTRATION (review of #3786, P3).
 *
 * The checkpoint stores the UI buffer's rows before it exports through the observer each page hands
 * the session (`messageIngestObserver`, built by `useMessaging.bulkIngestObserver` with every hook
 * required). Deleting the line from either page, or the session's registration, left every
 * behavioural test green - the hold simply never ran.
 *
 * WHY A SOURCE GUARD. Mounting either page drags in the whole chat singleton; what has to be pinned
 * is that both build the one observer and that the session registers what they hand it.
 */
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('the UI buffer observer is wired on both pages and registered by the session', () => {
  it('MainChatPage hands the session the one observer', () => {
    expect(read('src/lib/components/MainChatPage.svelte')).toMatch(
      /messageIngestObserver: messaging\.bulkIngestObserver\(msgCtx\),/
    );
  });

  it('ChatBackgroundService hands the session the one observer', () => {
    expect(read('src/lib/components/layout/ChatBackgroundService.svelte')).toMatch(
      /messageIngestObserver: globalMessaging\.bulkIngestObserver\(msgCtx\),/
    );
  });

  it('the session registers it with the MLS service', () => {
    expect(read('src/lib/composables/session/sessionAuth.ts')).toMatch(
      /if \(cb\.messageIngestObserver\) mlsService\.addBulkIngestObserver\(cb\.messageIngestObserver\);/
    );
  });
});
