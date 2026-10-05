/**
 * THE ORDER OF A GROUP PHOTO AT START-UP. Before: a conversation row restored from the local store
 * carried NO photo id (`ConversationMeta` did not hold it), so group photos appeared only after the
 * server's group list arrived, seconds after people's avatars. Now the id travels with the row:
 * written by `toConversationMeta`, read back by the store, so it is known at FIRST render.
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from './indexeddb';
import { toConversationMeta } from '$lib/utils/chat/conversations';
import type { Conversation } from '$lib/types';

describe('group photo id in the local row', () => {
  it('survives a save and a read, so the first render has it', async () => {
    const storage = new IndexedDbStorage(`img-${Math.random().toString(36).slice(2)}`);
    await storage.init();
    const convo = {
      id: 'g1',
      name: 'Bureau',
      contactName: 'Bureau',
      conversationType: 'group',
      lifecycle: 'active',
      imageMediaId: 'media-42',
    } as unknown as Conversation;

    await storage.saveConversation(toConversationMeta('g1', convo, 'me'));
    const [row] = await storage.getConversations();

    expect(row.imageMediaId).toBe('media-42');
    await storage.close();
  });

  it('writes null for a group without a photo', () => {
    const convo = { id: 'g2', name: 'x', lifecycle: 'active' } as unknown as Conversation;
    expect(toConversationMeta('g2', convo, 'me').imageMediaId).toBeNull();
  });
});
