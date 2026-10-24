import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE SHARE SHEET'S SUGGESTIONS (sharing lot S5) HANG ON THREE FILES IN TWO LANGUAGES.
 *
 * A published shortcut is offered in Android's share sheet only when its category is one a
 * `<share-target>` of `res/xml/shortcuts.xml` declares, and that file is read only through the
 * `android.app.shortcuts` meta-data on the activity. Drop the meta-data (a `tauri android init`
 * regenerating the manifest), or let the Kotlin category drift from the XML one, and every build
 * stays green while the suggestions silently never appear. The share-target's types must be the
 * ones MainActivity's SEND filter accepts, or a suggestion is offered for content the activity
 * then cannot take.
 *
 * Comments are stripped first: a commented tag is not a tag.
 */
const here = dirname(fileURLToPath(import.meta.url));
const ANDROID = resolve(here, '../../../src-tauri/gen/android/app/src/main');

function withoutComments(xml: string): string {
  return xml
    .split('<!--')
    .map((chunk, i) => (i === 0 ? chunk : chunk.slice(chunk.indexOf('-->') + 3)))
    .join('');
}

const manifest = withoutComments(readFileSync(resolve(ANDROID, 'AndroidManifest.xml'), 'utf8'));
const shortcuts = withoutComments(readFileSync(resolve(ANDROID, 'res/xml/shortcuts.xml'), 'utf8'));
const kotlin = readFileSync(
  resolve(
    here,
    '../../../src-tauri/plugins/tauri-plugin-gallery/android/src/main/java/ShareTargets.kt'
  ),
  'utf8'
);

/**
 * Kotlin without its comments: a doc block naming a call to say why it is NOT used is not a use.
 * A scan, not a regex: a `/*` or `//` inside a string literal (`"image/*"`, a URL) opens no comment,
 * and a regex reading it as one would hide the code after it from every assertion below.
 */
function codeOnly(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      const stop = end === -1 ? source.length : end + 3;
      out += source.slice(i, stop);
      i = stop;
    } else if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length && source[j] !== quote && source[j] !== '\n') {
        j += source[j] === '\\' ? 2 : 1;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (two === '//') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
    } else {
      out += source[i];
      i += 1;
    }
  }
  return out;
}

it('strips comments but never a comment marker inside a string', () => {
  const code = codeOnly('val m = "image/*" // gone\ncall() /* gone */ val u = "https://x"');
  expect(code).toContain('"image/*"');
  expect(code).toContain('call()');
  expect(code).toContain('"https://x"');
  expect(code).not.toContain('gone');
});

/** The `<activity>` element declaring MainActivity, up to its closing tag. */
function mainActivity(): string {
  const start = manifest.indexOf('android:name=".MainActivity"');
  expect(start).toBeGreaterThan(-1);
  return manifest.slice(
    manifest.lastIndexOf('<activity', start),
    manifest.indexOf('</activity>', start)
  );
}

/** The mime types of MainActivity's SEND intent-filter. */
function sendFilterTypes(): string[] {
  const share = mainActivity()
    .split('<intent-filter')
    .slice(1)
    .find((f) => f.includes('android.intent.action.SEND"'));
  expect(share, 'MainActivity has no SEND intent-filter').toBeDefined();
  return [...(share ?? '').matchAll(/android:mimeType="([^"]+)"/g)].map((m) => m[1]);
}

describe('the share sheet suggestions are declared', () => {
  it('MainActivity carries the shortcuts meta-data', () => {
    expect(mainActivity()).toMatch(
      /<meta-data\s+android:name="android\.app\.shortcuts"\s+android:resource="@xml\/shortcuts"\s*\/>/
    );
  });

  it('the share-target names MainActivity', () => {
    expect(shortcuts).toMatch(
      /<share-target\s+android:targetClass="fr\.emse\.canari\.MainActivity">/
    );
  });

  it('declares the category the Kotlin publishes under', () => {
    const published = /const val CATEGORY = "([^"]+)"/.exec(kotlin)?.[1];
    expect(published).toBeDefined();
    expect(shortcuts).toContain(`<category android:name="${published}" />`);
    expect(kotlin).toMatch(/\.setCategories\(setOf\(CATEGORY\)\)/);
  });

  it('offers the suggestions for exactly the types the SEND filter accepts', () => {
    const declared = [...shortcuts.matchAll(/android:mimeType="([^"]+)"/g)].map((m) => m[1]);
    const accepted = sendFilterTypes();
    expect(accepted.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...accepted].sort());
  });
});

/**
 * The shortcut id is written by the page, read back by `IncomingShare.kt` from the SEND intent and
 * refused by `ShareTargets.kt` in any other shape: the three must name one prefix.
 */
describe('the suggestion id has one shape on every side', () => {
  const page = readFileSync(resolve(here, '../sharing/shareTargetsNative.ts'), 'utf8');
  const incoming = readFileSync(resolve(ANDROID, 'java/fr/emse/canari/IncomingShare.kt'), 'utf8');

  it('uses the same prefix in the page, the publisher and the share capture', () => {
    const prefix = /SHARE_TARGET_PREFIX = '([^']+)'/.exec(page)?.[1];
    expect(prefix).toBeDefined();
    expect(kotlin).toContain(`ID_PREFIX = "${prefix}"`);
    expect(incoming).toContain(`id.startsWith("${prefix}")`);
    expect(incoming).toMatch(/getStringExtra\(ShortcutManagerCompat\.EXTRA_SHORTCUT_ID\)/);
    expect(incoming).toMatch(/payload\.put\("target", target\)/);
  });

  it('never replaces the whole dynamic set, which holds the notification shortcuts too', () => {
    const code = codeOnly(kotlin);
    expect(code).toMatch(/removeDynamicShortcuts\(context, ids\)/);
    expect(code).not.toMatch(/setDynamicShortcuts|removeAllDynamicShortcuts/);
  });
});

/**
 * The notifications' `chat_<group>` conversation shortcuts carry a conversation name and a face,
 * so they are erased at sign-out too - which works only if EVERY one is recorded before it is
 * pushed. A push straight to `ShortcutManagerCompat` from the messaging service would publish one
 * no sign-out can name.
 */
describe('the conversation shortcuts are recorded, and erased by that record', () => {
  const service = readFileSync(
    resolve(ANDROID, 'java/fr/emse/canari/CanariFirebaseMessagingService.kt'),
    'utf8'
  );
  const conversations = readFileSync(
    resolve(
      here,
      '../../../src-tauri/plugins/tauri-plugin-gallery/android/src/main/java/ConversationShortcuts.kt'
    ),
    'utf8'
  );

  it('the messaging service pushes them only through the recorder', () => {
    const code = codeOnly(service);
    expect(code).toMatch(/ConversationShortcuts\.push\(context, info\)/);
    expect(code).toMatch(/"\$\{ConversationShortcuts\.ID_PREFIX\}\$groupId"/);
    expect(code).not.toMatch(/pushDynamicShortcut|addDynamicShortcuts|setDynamicShortcuts/);
  });

  it('the recorder records before it pushes, and erases long-lived copies by the record', () => {
    const code = codeOnly(conversations);
    const recorded = code.indexOf('record.write(context, ids)');
    const pushed = code.indexOf('pushDynamicShortcut(context, info)');
    expect(recorded).toBeGreaterThan(-1);
    expect(pushed).toBeGreaterThan(recorded);
    expect(code).toMatch(/if \(!record\.write\(context, ids\)\)/);
    expect(code).toMatch(/removeLongLivedShortcuts\(context, ids\)/);
    expect(code).toMatch(/const val CAP = \d+/);
  });
});
