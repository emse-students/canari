#!/usr/bin/env bun
/**
 * The demo photos: nothing heavy is committed, the manifest is.
 *
 *   bun photos.mjs resolve            rewrite photos.manifest.json from photos.titles.json (live Commons API)
 *   bun photos.mjs fetch [--dir DIR]  download every manifest entry (default .photos/), check its sha256 once pinned
 *
 * Each manifest entry records the source page, the author, the licence and its URL, so the attribution a
 * licence demands can be produced from the committed file alone.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, 'photos.manifest.json');
/** Licences that allow reuse in a store listing with attribution; anything else is refused. */
export const ALLOWED = ['Public domain', 'CC0', 'CC BY 2.0', 'CC BY 3.0', 'CC BY 4.0', 'CC BY-SA 2.0', 'CC BY-SA 3.0', 'CC BY-SA 4.0'];
const UA = { 'user-agent': 'canari-store-shots/1.0 (https://github.com/emse-students/canari)' };
const strip = (h) => (h ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

async function resolveManifest() {
  const { titles } = JSON.parse(readFileSync(join(HERE, 'photos.titles.json'), 'utf8'));
  const entries = [];
  for (const title of titles) {
    const u = new URL('https://commons.wikimedia.org/w/api.php');
    for (const [k, v] of Object.entries({ action: 'query', titles: title, prop: 'imageinfo', iiprop: 'url|extmetadata|size', iiurlwidth: '1600', format: 'json' })) u.searchParams.set(k, v);
    const page = Object.values((await (await fetch(u, { headers: UA })).json()).query.pages)[0];
    const ii = page.imageinfo?.[0];
    if (!ii) throw new Error(`no such file on Commons: ${title}`);
    const lic = ii.extmetadata.LicenseShortName?.value ?? '';
    if (!ALLOWED.includes(lic)) throw new Error(`${title}: licence "${lic}" is not in the allowlist`);
    entries.push({
      title,
      sourceUrl: ii.descriptionurl,
      downloadUrl: ii.thumburl,
      author: strip(ii.extmetadata.Artist?.value),
      license: lic,
      licenseUrl: ii.extmetadata.LicenseUrl?.value ?? null,
      sha256: null,
    });
  }
  writeFileSync(MANIFEST, JSON.stringify({ entries }, null, 2) + '\n');
  console.log(`wrote ${entries.length} entries`);
}

async function fetchAll() {
  const i = process.argv.indexOf('--dir');
  const dir = resolve(i === -1 ? join(HERE, '.photos') : process.argv[i + 1]);
  mkdirSync(dir, { recursive: true });
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  for (const [n, e] of m.entries.entries()) {
    if (!ALLOWED.includes(e.license)) throw new Error(`${e.title}: licence not allowed`);
    const file = join(dir, `photo-${n + 1}.jpg`);
    if (!existsSync(file)) writeFileSync(file, Buffer.from(await (await fetch(e.downloadUrl, { headers: UA })).arrayBuffer()));
    const sum = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (e.sha256 && e.sha256 !== sum) throw new Error(`${e.title}: sha256 changed`);
    console.log(file, sum.slice(0, 12), e.license);
  }
}

if (import.meta.main) {
  const c = process.argv[2];
  if (c === 'resolve') await resolveManifest();
  else if (c === 'fetch') await fetchAll();
  else { console.error('usage: bun photos.mjs resolve|fetch'); process.exit(2); }
}
