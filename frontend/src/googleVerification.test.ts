import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Google Search Console ownership file.
 *
 * Google fetches `/googlea035227b58453615.html` and wants a 200 whose body is exactly the line
 * below. The file lives in `static/`, which adapter-node copies to `build/client`; nginx serves it
 * from its own COPY through the catch-all `location /` (`try_files $uri @ssr`), so a file on disk
 * is answered by nginx as text/html and never reaches the SPA fallback. Both halves are pinned:
 * the bytes, and the nginx rule that serves them.
 */
const TOKEN = 'googlea035227b58453615.html';

describe('static/' + TOKEN, () => {
  it('holds the one verification line Google expects', () => {
    expect(readFileSync(`static/${TOKEN}`, 'utf8').trim()).toBe(
      `google-site-verification: ${TOKEN}`
    );
  });

  it('is served from disk by the nginx catch-all, not by the SPA fallback', () => {
    const nginx = readFileSync('../infrastructure/local/Dockerfile.frontend', 'utf8');
    expect(nginx).toMatch(/location \/ \{\\n\\\s*try_files \$uri @ssr;/);
  });
});
