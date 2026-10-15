/**
 * F4: the boot restore no longer erases a salon's stored page - it is the copy the salon's next open
 * draws first. Source guard: the restore is driven elsewhere, this pins the one line that changed.
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
