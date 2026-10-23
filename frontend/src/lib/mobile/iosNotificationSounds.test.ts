import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE iPHONE PLAYS THE PALETTE-A TRILLS ONLY IF FOUR PLACES SPELL THE SAME THREE FILE NAMES AND THE
 * XCODE PROJECT BUNDLES THEM (docs/wiki/frontend/sounds.md).
 *
 * A banner's sound is a FILE NAME: the APNs `sound` the delivery service writes
 * (`IOS_NOTIFICATION_SOUND` in `push-payload.ts`), the local notifications `canari_push.mm` posts,
 * and the mention trill the extension sets after decrypting. iOS resolves the name against the
 * bundle and, when it is absent, plays the system default without a word - so a typo in any of the
 * four, or a file missing from a target's Resources phase, is a silent regression no compiler and no
 * gate here sees. The project file is hand-maintained (`gen/apple/README.md`), so this reads it.
 *
 * The files are NOT copied: the group points at the Android `res/raw` the renderer writes, so the
 * drift test of the Android channels (`notificationSoundsDrift.test.ts`) also covers the iPhone.
 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const APPLE = resolve(REPO, 'frontend/src-tauri/gen/apple');
const RAW = resolve(REPO, 'frontend/src-tauri/gen/android/app/src/main/res/raw');

const read = (path: string) => readFileSync(path, 'utf8');
const pushPayload = read(resolve(REPO, 'apps/chat-delivery-service/src/services/push-payload.ts'));
const pushMm = read(resolve(APPLE, 'Sources/canari/canari_push.mm'));
const nse = read(resolve(APPLE, 'canari_NSE/NotificationService.swift'));
const pbx = read(resolve(APPLE, 'canari.xcodeproj/project.pbxproj'));

/** The server's table, read from its source: the one spelling the other three must match. */
function serverSounds(): Record<string, string> {
  const block = pushPayload.match(/export const IOS_NOTIFICATION_SOUND = \{([\s\S]*?)\} as const/);
  expect(block, 'IOS_NOTIFICATION_SOUND introuvable dans push-payload.ts').not.toBeNull();
  const entries = [...(block?.[1] ?? '').matchAll(/(\w+): '([^']+)'/g)];
  return Object.fromEntries(entries.map((e) => [e[1], e[2]]));
}

/** The `files = (...)` list of one PBXResourcesBuildPhase, by the phase's object id. */
function resourcePhase(id: string): string {
  const phase = pbx.match(
    new RegExp(`${id} /\\* Resources \\*/ = \\{[\\s\\S]*?files = \\(([\\s\\S]*?)\\);`)
  );
  expect(phase, `phase Resources ${id} introuvable dans project.pbxproj`).not.toBeNull();
  return phase?.[1] ?? '';
}

/** The app target's and the extension's Resources phases (`canari_iOS`, `CanariNotifications`). */
const APP_RESOURCES = 'BC32686DC31C14F7003DB687';
const NSE_RESOURCES = 'BD49C848300FABF7000960D5';

describe('iOS notification sounds (palette A)', () => {
  const sounds = serverSounds();

  it('the server names the three trills, and each is a rendered file', () => {
    expect(Object.keys(sounds).sort()).toEqual(['mention', 'message', 'reaction']);
    for (const file of Object.values(sounds)) {
      expect(existsSync(resolve(RAW, file)), `${file} absent de res/raw`).toBe(true);
    }
  });

  it('canari_push.mm and the extension spell the same names', () => {
    expect(pushMm).toContain(`kCanariSoundMessage = @"${sounds.message}"`);
    expect(pushMm).toContain(`kCanariSoundMention = @"${sounds.mention}"`);
    expect(pushMm).toContain(`kCanariSoundReaction = @"${sounds.reaction}"`);
    expect(nse).toContain(`mentionSoundFile = "${sounds.mention}"`);
    expect(nse).toContain(`messageSoundFile = "${sounds.message}"`);
  });

  it('the project bundles each file in BOTH the app and the extension', () => {
    const group = pbx.match(/\/\* NotificationSounds \*\/ = \{[\s\S]*?path = ([^;]+);/);
    expect(group?.[1], 'groupe NotificationSounds absent').toBe('../android/app/src/main/res/raw');
    const app = resourcePhase(APP_RESOURCES);
    const ext = resourcePhase(NSE_RESOURCES);
    for (const file of Object.values(sounds)) {
      const ref = pbx.match(
        new RegExp(`(\\w{24}) /\\* ${file} \\*/ = \\{isa = PBXFileReference;[^}]*path = ${file};`)
      )?.[1];
      expect(ref, `aucune PBXFileReference pour ${file}`).toBeDefined();
      const builds = [
        ...pbx.matchAll(
          new RegExp(
            `(\\w{24}) /\\* ${file} in Resources \\*/ = \\{isa = PBXBuildFile; fileRef = ${ref} `,
            'g'
          )
        ),
      ].map((m) => m[1]);
      expect(
        builds.some((id) => app.includes(id)),
        `${file} absent des Resources de l'app`
      ).toBe(true);
      expect(
        builds.some((id) => ext.includes(id)),
        `${file} absent des Resources de l'extension`
      ).toBe(true);
    }
  });
});
