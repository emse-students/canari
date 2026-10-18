import { of, throwError } from 'rxjs';
import type { HttpService } from '@nestjs/axios';
import { HttpLiveSegmentStore } from './live-segment-store';

const LIVE = '11111111-1111-4111-8111-111111111111';
const NAME = '22222222-2222-4222-8222-222222222222';

describe('HttpLiveSegmentStore', () => {
  const saved = { secret: process.env.INTERNAL_SECRET, media: process.env.MEDIA_SERVICE_URL };
  beforeEach(() => {
    process.env.INTERNAL_SECRET = 's3cret';
    process.env.MEDIA_SERVICE_URL = 'http://media-service:3011';
  });
  afterEach(() => {
    process.env.INTERNAL_SECRET = saved.secret;
    process.env.MEDIA_SERVICE_URL = saved.media;
  });

  it("stores a segment on media-service's internal route, with the secret, as a multipart file", async () => {
    const post = jest.fn().mockReturnValue(of({ data: { ok: true } }));
    await new HttpLiveSegmentStore({ post } as unknown as HttpService).store(
      LIVE,
      NAME,
      Buffer.from('sealed')
    );
    const [url, , config] = post.mock.calls[0];
    expect(url).toBe(`http://media-service:3011/api/media/internal/live/${LIVE}/${NAME}`);
    expect(config.headers['x-internal-secret']).toBe('s3cret');
    expect(config.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
  });

  it('THROWS when the store fails, so the ingest records nothing', async () => {
    const post = jest.fn().mockReturnValue(throwError(() => new Error('ECONNREFUSED')));
    await expect(
      new HttpLiveSegmentStore({ post } as unknown as HttpService).store(
        LIVE,
        NAME,
        Buffer.from('x')
      )
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('returns the purge counts, and refuses an answer that does not carry all three', async () => {
    const answer = { deleted: 2, failed: 0, remaining: 0 };
    const post = jest.fn().mockReturnValue(of({ data: answer }));
    const store = new HttpLiveSegmentStore({ post } as unknown as HttpService);
    await expect(store.purge(LIVE)).resolves.toEqual(answer);
    expect(post).toHaveBeenCalledWith(
      'http://media-service:3011/api/media/internal/live-purge',
      { liveId: LIVE },
      { headers: { 'x-internal-secret': 's3cret' } }
    );
    post.mockReturnValue(of({ data: { deleted: 2 } }));
    await expect(store.purge(LIVE)).rejects.toThrow(/three counts/);
  });

  it('lists the live folders, and refuses an answer that is not a list of ids', async () => {
    const post = jest.fn().mockReturnValue(of({ data: { liveIds: [LIVE] } }));
    const store = new HttpLiveSegmentStore({ post } as unknown as HttpService);
    await expect(store.listLives()).resolves.toEqual([LIVE]);
    expect(post).toHaveBeenCalledWith(
      'http://media-service:3011/api/media/internal/live-list',
      {},
      { headers: { 'x-internal-secret': 's3cret' } }
    );
    post.mockReturnValue(of({ data: { liveIds: [1] } }));
    await expect(store.listLives()).rejects.toThrow(/liveIds/);
  });
});
