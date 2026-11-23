import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * EVERY WRITE ROUTE OF `PostsController` EITHER ASKS THE MUTE OR IS NAMED HERE WITH WHY IT MAY NOT
 * (moderation-authority, decision 9). The next participating route cannot forget `assertNotMuted`:
 * it fails this spec until it calls it or is listed, and a listing is a decision someone reads.
 */
const EXEMPT: Record<string, string> = {
  markAllRead: 'reads the reader own bell: adds nothing for anybody',
  markPostRead: 'reads the reader own bell: adds nothing for anybody',
  updatePost: 'corrects what the reader already published, behind the publisher check',
  withdrawPost: 'takes back the reader own post',
  deletePost: 'takes back the reader own post, or a moderator deletion',
  removeReaction: 'takes back the reader own reaction: adds nothing',
  editComment: 'corrects the reader own comment, behind commentRights',
  deleteComment: 'takes back the reader own comment, or a moderator deletion',
  unmaskPost: 'a moderation act, not participation',
  hidePost: 'a moderation act, not participation',
  unhidePost: 'a moderation act, not participation',
};

const source = readFileSync(join(__dirname, 'posts.controller.ts'), 'utf8');

/** Every mutating route: its handler name and the text of its whole declaration. */
const routes = source
  .split(/\n(?=  @(?:HttpPost|Patch|Put|Delete)\()/)
  .slice(1)
  .map((chunk) => {
    const name = /\n  (?:async )?(\w+)\(/.exec(chunk)?.[1];
    return { name: name as string, body: chunk };
  });

describe('PostsController - every write route asks the mute or is exempt', () => {
  it('finds the write routes (the parse itself is not vacuous)', () => {
    const names = routes.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['createPost', 'votePoll', 'likeComment']));
    expect(names.every(Boolean)).toBe(true);
  });

  it.each(routes.map((r) => [r.name, r.body] as const))(
    '%s calls assertNotMuted or is named in the exemption list',
    (name, body) => {
      const asks = body.includes('this.assertNotMuted(');
      expect(asks || name in EXEMPT).toBe(true);
    }
  );

  it('lists no exemption for a route that already asks, nor one that does not exist', () => {
    const byName = new Map(routes.map((r) => [r.name, r.body]));
    for (const name of Object.keys(EXEMPT)) {
      expect(byName.has(name)).toBe(true);
      expect(byName.get(name)).not.toContain('this.assertNotMuted(');
    }
  });
});
