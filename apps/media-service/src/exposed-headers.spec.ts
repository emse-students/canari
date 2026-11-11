import { buildAllowedOrigins, corsOptions } from './cors-origins';
import { MEDIA_EXPOSED_HEADERS } from './exposed-headers';

describe('the media service exposes what its cross-origin clients read', () => {
  it('names Content-Range, which a phone needs to join the rest of a file to its head', () => {
    let exposed: unknown;
    corsOptions(buildAllowedOrigins('https://canari.emse.fr'), MEDIA_EXPOSED_HEADERS)(
      { originalUrl: '/api/media/x' },
      (err, options) => {
        if (err) throw err;
        exposed = (options as { exposedHeaders?: string[] }).exposedHeaders;
      }
    );
    expect(exposed).toContain('Content-Range');
  });
});
