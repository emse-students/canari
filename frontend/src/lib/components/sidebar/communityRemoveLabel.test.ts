import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';

/**
 * EVERY ROW OF "MEMBRES" HAS A REMOVE CONTROL, AND A SCREEN READER MUST HEAR WHOSE (2026-11-17): the
 * label was one string for all rows, "Retirer le membre". Source pin, as the panel needs a whole
 * community to mount.
 */
describe('community member remove control label', () => {
  it('names the member in the message', () => {
    expect(m.chat_community_remove_member_label({ member: 'Ada Lovelace' })).toContain(
      'Ada Lovelace'
    );
  });

  it('the panel labels the row control with the member, not the generic title', () => {
    const src = readFileSync(
      'src/lib/components/sidebar/SidebarCommunityAdminPanel.svelte',
      'utf8'
    );
    expect(src).toMatch(/aria-label=\{m\.chat_community_remove_member_label\(/);
    expect(src).not.toMatch(/aria-label=\{m\.chat_community_remove_member_title\(\)\}/);
  });
});
