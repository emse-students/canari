/**
 * Push `store/listings/<lang>.json` to Google Play. DRY RUN by default: prints a diff against the
 * live listing and writes nothing. `--apply` updates the listings and the contact website inside
 * one edit and commits it; any failure deletes the edit.
 *
 * Run: bun tools/store-listings/play.mjs [--apply] [--images <dir>]
 *
 * Reuses the service account of tools/play-vitals/lib.mjs. App Store texts ride the release
 * (`tools/app-store/submit.mjs`) and are only validated here.
 */

import { api, PKG, PUBLISHER } from '../play-vitals/lib.mjs';
import {
  loadListings,
  pick,
  validateImagesDir,
  validateListing,
  validateParity,
} from './listings.mjs';

const FIELDS = ['title', 'shortDescription', 'fullDescription'];
const base = `${PUBLISHER}/applications/${PKG}`;

const apply = process.argv.includes('--apply');
const imagesIdx = process.argv.indexOf('--images');
const imagesDir = imagesIdx > 0 ? process.argv[imagesIdx + 1] : null;

const listings = loadListings();
const problems = [
  ...Object.entries(listings).flatMap(([l, v]) => validateListing(l, v)),
  ...validateParity(listings),
  ...(imagesDir ? validateImagesDir(imagesDir) : []),
];
if (problems.length) {
  for (const p of problems) console.error(`  ! ${p}`);
  process.exit(1);
}

/** Call and require 2xx, naming the step in the failure. */
async function must(step, url, init) {
  const r = await api(url, init);
  if (!r.ok) throw new Error(`${step} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

const edit = await must('edits.insert', `${base}/edits`, { method: 'POST', body: '{}' });
let committed = false;
try {
  const live = await must('listings.list', `${base}/edits/${edit.id}/listings`);
  const details = await must('details.get', `${base}/edits/${edit.id}/details`);
  let changes = 0;

  for (const listing of Object.values(listings)) {
    const code = listing.playLanguage;
    const current = (live.listings ?? []).find((l) => l.language === code) ?? {};
    for (const field of FIELDS) {
      const next = listing.play[field];
      if (current[field] === next) continue;
      changes++;
      console.log(`--- ${code} ${field}\n- ${current[field] ?? '(none)'}\n+ ${next}\n`);
    }
  }
  const website = pick(Object.values(listings)[0], 'play.contactWebsite');
  if (details.contactWebsite !== website) {
    changes++;
    console.log(`--- contactWebsite\n- ${details.contactWebsite}\n+ ${website}\n`);
  }
  console.log(`${changes} change(s). ${apply ? 'Applying.' : 'Dry run, pass --apply to write.'}`);

  if (apply && changes > 0) {
    for (const listing of Object.values(listings)) {
      const code = listing.playLanguage;
      await must(`listings.update ${code}`, `${base}/edits/${edit.id}/listings/${code}`, {
        method: 'PUT',
        body: JSON.stringify({
          language: code,
          ...Object.fromEntries(FIELDS.map((f) => [f, listing.play[f]])),
        }),
      });
    }
    await must('details.patch', `${base}/edits/${edit.id}/details`, {
      method: 'PATCH',
      body: JSON.stringify({ contactWebsite: website }),
    });
    await must('edits.commit', `${base}/edits/${edit.id}:commit`, { method: 'POST', body: '{}' });
    committed = true;
    console.log('Committed.');
  }
} catch (e) {
  console.error(`  ! ${e.message}`);
  process.exitCode = 1;
} finally {
  if (!committed) await api(`${base}/edits/${edit.id}`, { method: 'DELETE' });
}
