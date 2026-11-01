import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A live films and records: App Review (guideline 5.1.1) reads the camera and microphone purpose
 * strings as the list of what the app uses them for, so they must name lives exactly when the binary
 * can broadcast one (`LIVE_ENABLED`, `features.ts`). Read as TEXT, as `callsCompiled.test.ts` reads
 * its own switches: importing `features.ts` would evaluate its env. Every copy is checked - the
 * base `Info.plist`, `project.yml` (which regenerates it) and both localized `InfoPlist.strings`.
 * See docs/wiki/frontend/modules/live-production.md.
 */
const here = dirname(fileURLToPath(import.meta.url));
const APPLE = resolve(here, '../../../src-tauri/gen/apple');
const read = (path: string) => readFileSync(path, 'utf8');

/** The one capture group of `pattern` in `src`, or fail naming what went missing. */
function captured(src: string, pattern: RegExp, what: string): string {
  const match = src.match(pattern);
  expect(match, `${what} was renamed or removed`).not.toBeNull();
  return match![1];
}

const LIVES_COMPILED =
  captured(
    read(resolve(here, '../features.ts')),
    /export const LIVE_ENABLED = (true|false);/,
    'LIVE_ENABLED as a literal'
  ) === 'true';

/** Every copy of one purpose string, with where it was read. */
function purposes(key: 'NSCameraUsageDescription' | 'NSMicrophoneUsageDescription') {
  const plist = read(resolve(APPLE, 'canari_iOS/Info.plist'));
  const projectYml = read(resolve(APPLE, 'project.yml'));
  const out = [
    {
      where: 'Info.plist',
      text: captured(
        plist,
        new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`),
        `${key} in Info.plist`
      ),
    },
    {
      where: 'project.yml',
      text: captured(projectYml, new RegExp(`${key}: (.*)\\r?\\n`), `${key} in project.yml`),
    },
  ];
  for (const lang of ['fr', 'en']) {
    const strings = read(resolve(APPLE, `canari_iOS/${lang}.lproj/InfoPlist.strings`));
    out.push({
      where: `${lang}.lproj`,
      text: captured(strings, new RegExp(`"${key}"\\s*=\\s*"([^"]*)";`), `${key} in ${lang}.lproj`),
    });
  }
  return out;
}

describe('the camera and microphone purpose strings name lives when lives are compiled', () => {
  for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription'] as const) {
    it(key, () => {
      for (const { where, text } of purposes(key)) {
        // Whole words: "directs" (fr) or "lives" (en).
        expect(/\b(directs?|lives?)\b/i.test(text), `${key} (${where}): "${text}"`).toBe(
          LIVES_COMPILED
        );
      }
    });
  }

  it('project.yml carries the same base strings as Info.plist, so a regeneration keeps them', () => {
    for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription'] as const) {
      const [plist, yml] = purposes(key);
      expect(yml.text.trim(), key).toBe(plist.text);
    }
  });
});
