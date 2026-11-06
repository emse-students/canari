/**
 * `deleteWithdrawnMedia`: the publish queue's Delete hands social-service the media it uploaded for
 * a post it takes back. Owner and class (media-service's checks) do not prove an object is uncited -
 * an uploader's `archive` objects include their published posts' media, an association's among them
 * (review of #3061). So the ids a live post or comment cites are NEVER sent for deletion.
 */
import { of } from 'rxjs';
import type { HttpService } from '@nestjs/axios';
import type { Repository } from 'typeorm';
import { PostMediaRetentionService } from './post-media-retention.service';
import type { Post } from './entities/post.entity';

const FREE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CITED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GONE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REEL = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function build(cited: string[], results: Record<string, string>) {
  const query = jest.fn((_sql: string, [ids]: [string[]]) =>
    Promise.resolve(ids.filter((id) => cited.includes(id)).map((mediaId) => ({ mediaId })))
  );
  const post = jest.fn((_url: string, body: { items: Array<{ mediaId: string }> }) =>
    of({
      data: { results: Object.fromEntries(body.items.map((i) => [i.mediaId, results[i.mediaId]])) },
    })
  );
  const service = new PostMediaRetentionService(
    { post } as unknown as HttpService,
    { query } as unknown as Repository<Post>
  );
  return { service, query, post };
}

describe('PostMediaRetentionService.deleteWithdrawnMedia', () => {
  it('sends only the ids no live row cites, each under the withdrawing author', async () => {
    const { service, post } = build([CITED], { [FREE]: 'deleted', [GONE]: 'absent' });
    await expect(service.deleteWithdrawnMedia('alice', [FREE, CITED, GONE, FREE])).resolves.toEqual(
      { deleted: 1, absent: 1, cited: 1, refused: 0, notTaken: [] }
    );
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0];
    expect(url).toContain('media/internal/own-archive-delete');
    expect(body.items).toEqual([
      { mediaId: FREE, ownerId: 'alice' },
      { mediaId: GONE, ownerId: 'alice' },
    ]);
  });

  it('asks media-service nothing when every id is cited, or when there are none', async () => {
    const { service, post, query } = build([CITED], {});
    await expect(service.deleteWithdrawnMedia('alice', [CITED])).resolves.toMatchObject({
      cited: 1,
    });
    await service.deleteWithdrawnMedia('alice', []);
    expect(post).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('counts a reel a salon message shares as CITED: the citation read covers channel_messages', async () => {
    const { service, post, query } = build([REEL], {});
    await expect(service.deleteWithdrawnMedia('alice', [REEL])).resolves.toMatchObject({
      cited: 1,
    });
    expect(post).not.toHaveBeenCalled();
    // The shape of the read: the salon branch is one of its three, on the reel column.
    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/FROM channel_messages cm/);
    expect(sql).toMatch(/cm\."reelMediaId"::text = ANY\(\$1::text\[\]\)/);
  });

  it("counts a media-service refusal (another uploader's, or not a post's media)", async () => {
    const { service } = build([], { [FREE]: 'refused' });
    await expect(service.deleteWithdrawnMedia('alice', [FREE])).resolves.toMatchObject({
      refused: 1,
      deleted: 0,
      notTaken: [FREE],
    });
  });
});
