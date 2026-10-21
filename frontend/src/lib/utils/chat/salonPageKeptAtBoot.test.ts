/**
 * F4: the boot restore no longer erases a salon's stored page - it is the copy the salon's next open
 * draws first. Source guard: the restore is driven elsewhere, this pins the one line that changed.
 *
 * WHY A SOURCE TEST (WP-T5 disposition: keep). `loadExistingConversations` takes a live MLS service,
 * a storage backend and a history gateway; driving it to observe one `continue` would assert its own
 * mocks. The regression is a deleted statement, which nothing else in the suite would notice.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/lib/utils/chat/conversations.ts'), 'utf8');

describe('the boot restore and salon pages', () => {
  it('skips a salon without deleting its stored page', () => {
    expect(source).toContain('if (isChannelConversationId(meta.id)) continue;');
    expect(source).not.toMatch(/deleteMessagesForConversation\(meta\.id\)/);
  });
});
